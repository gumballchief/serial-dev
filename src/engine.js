// The serial-dev loop, shared by the CLI and the MCP server:
//   post (X / Truth / news / viral / trending on pump) -> checks -> name -> picture -> launch
//   -> burst copies -> relaunch while the post is hot and every copy so far died.
import { draftCoin } from "./draft.js";
import { checkItem, checkLimits, rulesFor } from "./guards.js";
import { chooseImage } from "./images.js";
import { launches, markSeen, readLedger, record } from "./ledger.js";
import { publishMetadata } from "./metadata.js";
import * as pump from "./pump.js";
import { Feed } from "./sources.js";
import { TrendWatcher, trendToItem } from "./trend.js";
import { getTweet } from "./tweets.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => Number(lamports) / 1e9;

export async function resolveTweet(input, cfg) {
  if (input && typeof input === "object" && input.id) return input;
  return { ...(await getTweet(input, cfg)), source: "x", kind: "post" };
}

// What we keep about a post so a later relaunch can rebuild it.
const snapshot = (item) => ({
  id: item.id,
  url: item.url,
  text: String(item.text || "").slice(0, 600),
  createdAt: item.createdAt,
  author: item.author,
  media: item.media,
  links: item.links,
  kind: item.kind,
  source: item.source,
  tier: item.tier,
  isReply: item.isReply,
  quoted: item.quoted ? { media: item.quoted.media } : null,
});

/**
 * Launch one coin from a post ("item"), or from a bare name/ticker/image.
 * opts: name, ticker, image (url or file), description, uri, devBuySol, holderReward,
 *       force (skip checks), copy (index when relaunching), used (pictures already used)
 */
export async function launchItem(cfg, wallet, item, opts = {}) {
  const rules = rulesFor(item, cfg);
  const isCopy = (opts.copy || 0) > 0;
  if (!opts.force && !isCopy) {
    const why = checkItem(item, cfg, rules);
    if (why) return { launched: false, skipped: why, post: item.url, tier: rules.tier };
  }
  const minBuy = Number(cfg.limits.minDevBuySol ?? 0);
  const devBuySol = Math.max(Number(opts.devBuySol ?? cfg.devBuySol) || 0, minBuy);
  if (!opts.force) {
    const why = checkLimits(cfg, devBuySol, { burst: isCopy });
    if (why) return { launched: false, skipped: why };
  }
  const draft = draftCoin(item, cfg, { ...(item.suggested || {}), ...opts });
  draft.ticker = draft.ticker.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 13);
  draft.name = draft.name.slice(0, 32);
  if (opts.uri) draft.uri = opts.uri;

  const t0 = Date.now();
  let pick = { how: "given", url: opts.image };
  if (!opts.image && !opts.uri) {
    // Dry runs never pay for a generated picture.
    const imgCfg = cfg.dryRun ? { ...cfg, image: { ...cfg.image, mode: "fast" } } : cfg;
    pick = await chooseImage(item, draft, imgCfg, { used: opts.used || [] });
  }
  if (pick.buffer) draft.imageBuffer = pick.buffer;
  else draft.image = pick.url || null;
  const t1 = Date.now();
  const meta = cfg.dryRun && !draft.uri ? { uri: "https://ipfs.io/ipfs/dry-run-placeholder", image: draft.image } : await publishMetadata(draft, cfg);
  const t2 = Date.now();
  const res = await pump.launch(cfg, wallet, { name: draft.name, ticker: draft.ticker, uri: meta.uri, devBuySol, holderReward: !!opts.holderReward });
  const t3 = Date.now();
  markSeen(item.id);
  const out = {
    launched: !res.dryRun,
    ...res,
    name: draft.name,
    ticker: draft.ticker,
    tier: rules.tier,
    source: item.source,
    copy: opts.copy || 0,
    picture: pick.how,
    image: meta.image || (pick.buffer ? "(generated)" : pick.url),
    uri: meta.uri,
    post: item.url || null,
    postAgeSeconds: item.createdAt ? Math.round((t0 - item.createdAt) / 1000) : null,
    timings: { pictureMs: t1 - t0, uploadMs: t2 - t1, launchMs: t3 - t2 },
    ...(draft.warnings?.length ? { warnings: draft.warnings } : {}),
  };
  if (!res.dryRun) {
    record({
      type: "launch",
      network: cfg.network,
      mint: res.mint,
      signature: res.signature,
      name: draft.name,
      ticker: draft.ticker,
      uri: meta.uri,
      imageUsed: pick.reference || pick.url || pick.how,
      imageUrl: meta.image || (opts.image && /^https?:/.test(opts.image) ? opts.image : null),
      picture: pick.how,
      devBuySol: res.devBuySol,
      solSpent: res.solSpent,
      narrative: item.id,
      copy: opts.copy || 0,
      tier: rules.tier,
      source: item.source,
      author: item.author?.handle || item.author?.name || null,
      postUrl: item.url || null,
      item: snapshot(item),
    });
  }
  return out;
}

// Launch from a tweet link, or a bare name/ticker/image (no post).
export async function launchCoin(cfg, wallet, opts = {}) {
  const item = opts.tweet
    ? await resolveTweet(opts.tweet, cfg)
    : {
        id: `manual:${opts.ticker || opts.name}:${Date.now()}`,
        url: opts.twitter || "",
        text: opts.description || opts.name || "",
        createdAt: Date.now(),
        author: { handle: "", name: "" },
        media: opts.image ? [{ type: "photo", url: opts.image }] : [],
        links: [],
        kind: "post",
        source: "manual",
        tier: "S",
      };
  if (!opts.tweet && (!opts.name || !opts.ticker)) throw new Error("A coin needs a name and a ticker (or a post to draft them from).");
  return launchItem(cfg, wallet, item, opts);
}

// All the copies launched for one post, oldest first.
export function copiesOf(cfg, narrativeOrMint) {
  const all = launches(cfg.network);
  const hit = all.find((e) => e.mint === narrativeOrMint || e.narrative === narrativeOrMint);
  if (!hit) return [];
  return all.filter((e) => e.narrative === hit.narrative);
}

// Launch the next copy of a post: same name, same ticker and, by default, the same picture
// (33 of 37 real relaunch groups kept the picture). newPicture: true picks a different one.
export async function relaunch(cfg, wallet, narrativeOrMint, { newPicture, ...opts } = {}) {
  const copies = copiesOf(cfg, narrativeOrMint);
  if (!copies.length) throw new Error("No launch found for that mint or post.");
  const first = copies[0];
  const item = { ...first.item, id: first.narrative };
  const keep = !(newPicture ?? cfg.relaunch.samePicture === false) && (first.uri || first.imageUrl);
  return launchItem(cfg, wallet, item, {
    name: first.name,
    ticker: first.ticker,
    copy: copies.length,
    ...(keep ? (first.uri ? { uri: first.uri, image: first.imageUrl || undefined } : { image: first.imageUrl }) : { used: copies.map((c) => c.imageUsed) }),
    ...opts,
  });
}

// Is any copy of this post alive (enough SOL in its curve)?
async function anyAlive(cfg, copies) {
  const map = await pump.curves(cfg, copies.map((c) => c.mint));
  return copies.some((c) => {
    const bc = map.get(c.mint);
    return bc && (bc.complete || sol(bc.realQuoteReserves) >= cfg.relaunch.deadBelowSol);
  });
}

// "Shit happens, sometimes copy 3 runs": while the post is fresh and every copy so far died, launch another.
export async function relaunchLoop(cfg, wallet, narrative, log = () => {}) {
  const r = cfg.relaunch;
  for (;;) {
    await sleep(r.checkAfterSeconds * 1000);
    const copies = copiesOf(cfg, narrative);
    if (!copies.length || copies.length >= r.maxCopies) return;
    const born = copies[0].item?.createdAt || Date.parse(copies[0].at);
    if (Date.now() - born > r.maxAgeMinutes * 60e3) return;
    if (await anyAlive(cfg, copies).catch(() => true)) return; // one is running: don't compete with it
    try {
      const res = await relaunch(cfg, wallet, narrative);
      if (res.skipped) return log(`relaunch ${copies[0].ticker}: ${res.skipped}`);
      log(`RELAUNCH #${res.copy + 1} $${res.ticker} "${res.name}" (${res.picture}) ${res.page || res.mint}`);
    } catch (e) {
      return log(`relaunch failed: ${e.message.split("\n")[0]}`);
    }
  }
}

export async function sellCoin(cfg, wallet, mint, percent) {
  const res = await pump.sell(cfg, wallet, mint, percent);
  if (!res.dryRun) record({ type: "sell", network: cfg.network, mint, percent: res.percent, solReceived: res.solReceived, signature: res.signature });
  return res;
}

export async function buyCoin(cfg, wallet, mint, amount) {
  const res = await pump.buy(cfg, wallet, mint, amount);
  if (!res.dryRun) record({ type: "buy", network: cfg.network, mint, solSpent: res.solSpent, signature: res.signature });
  return res;
}

export function myMints(cfg, limit = 300) {
  return launches(cfg.network)
    .slice(-limit)
    .map((e) => e.mint);
}

export async function fees(cfg, wallet) {
  return pump.creatorFees(cfg, wallet, myMints(cfg));
}

export async function claim(cfg, wallet, { force = false } = {}) {
  const min = Number(cfg.limits.claimMinSol ?? 0.005);
  if (!force) {
    const f = await pump.creatorFees(cfg, wallet, myMints(cfg));
    if (f.totalSol < min) return { solClaimed: 0, waiting: f.totalSol, note: 'Only ' + f.totalSol + ' SOL waiting; claiming under ' + min + ' SOL wastes fees (limits.claimMinSol). Use force to claim anyway.' };
  }
  const res = await pump.claimFees(cfg, wallet, myMints(cfg));
  if (res.solClaimed > 0) record({ type: "claim", network: cfg.network, solClaimed: res.solClaimed, signatures: res.signatures });
  return res;
}

// Which sources, tiers and accounts actually pull money in: SOL in each coin's curve right now.
export async function review(cfg, { hours = 24 } = {}) {
  const since = Date.now() - hours * 3600e3;
  const recent = launches(cfg.network).filter((e) => Date.parse(e.at) > since);
  const map = await pump.curves(cfg, recent.map((e) => e.mint));
  const rows = recent.map((e) => {
    const bc = map.get(e.mint);
    return { ...e, curveSol: bc ? sol(bc.realQuoteReserves) : 0, graduated: !!bc?.complete };
  });
  const group = (key) => {
    const g = {};
    for (const r of rows) {
      const k = r[key] || "(none)";
      g[k] ??= { launches: 0, alive: 0, graduated: 0, bestCurveSol: 0 };
      g[k].launches++;
      if (r.curveSol >= cfg.relaunch.deadBelowSol) g[k].alive++;
      if (r.graduated) g[k].graduated++;
      g[k].bestCurveSol = Math.max(g[k].bestCurveSol, +r.curveSol.toFixed(2));
    }
    return Object.fromEntries(Object.entries(g).sort((a, b) => b[1].bestCurveSol - a[1].bestCurveSol));
  };
  return {
    hours,
    launches: rows.length,
    bySource: group("source"),
    byTier: group("tier"),
    byAuthor: group("author"),
    byPicture: group("picture"),
    best: rows
      .sort((a, b) => b.curveSol - a.curveSol)
      .slice(0, 10)
      .map((r) => ({ ticker: r.ticker, name: r.name, curveSol: +r.curveSol.toFixed(2), graduated: r.graduated, source: r.source, author: r.author, copy: r.copy, mint: r.mint })),
  };
}

// Sell the dev buy by the config's exit rules: take profit at N x, or after N seconds, whichever first.
export async function runExit(cfg, wallet, mint, log = () => {}) {
  const { takeProfitX, sellAfterSeconds, sellPct } = cfg.exit;
  if (!takeProfitX && !sellAfterSeconds) return null;
  const start = Date.now();
  let base = null;
  for (;;) {
    await sleep(2500);
    let st;
    try {
      st = await pump.coinStatus(cfg, mint);
    } catch {
      continue;
    }
    base ??= st.marketCapSol;
    const x = base ? st.marketCapSol / base : 1;
    const timeUp = sellAfterSeconds && Date.now() - start >= sellAfterSeconds * 1000;
    if ((takeProfitX && x >= takeProfitX) || timeUp) {
      log(`exit ${mint}: ${x.toFixed(2)}x${timeUp ? " (time)" : ""}, selling ${sellPct}%`);
      try {
        return await sellCoin(cfg, wallet, mint, sellPct);
      } catch (e) {
        log(`exit ${mint} failed: ${e.message}`);
        return null;
      }
    }
    if (Date.now() - start > Math.max(sellAfterSeconds || 0, 3600) * 1000) return null;
  }
}

// Autopilot: every enabled source -> checks -> launch (+ burst copies) -> relaunch loop. One launch at a time.
export function autopilot(cfg, wallet, { log = console.log, decide } = {}) {
  const feed = new Feed(cfg);
  const trend = cfg.sources.trend?.enabled ? new TrendWatcher(cfg) : null;
  const queue = [];
  let busy = false;
  const next = async () => {
    if (busy || !queue.length) return;
    busy = true;
    const item = queue.shift();
    const who = item.author?.handle ? `@${item.author.handle}` : item.author?.name || item.source;
    try {
      const rules = rulesFor(item, cfg);
      const why = checkItem(item, cfg, rules);
      if (why) {
        log(`skip ${item.source} ${who}: ${why}`);
      } else {
        const draft = draftCoin(item, cfg, item.suggested || {});
        const choice = decide ? await decide(item, draft, rules) : {};
        if (choice === null) {
          markSeen(item.id);
          log(`pass ${who}: "${String(item.text).slice(0, 60)}"`);
        } else {
          let lastImage = null;
          for (let copy = 0; copy < Math.max(1, rules.copies || 1); copy++) {
            // Burst copies keep copy 1's picture, like real relaunches do.
            const keep = copy > 0 && cfg.relaunch.samePicture !== false && lastImage ? { image: lastImage } : {};
            const res = await launchItem(cfg, wallet, item, { ...choice, copy, ...keep });
            if (copy === 0 && res.image && /^https?:/.test(res.image)) lastImage = res.image;
            if (res.skipped) {
              log(`skip ${item.source} ${who}: ${res.skipped}`);
              break;
            }
            log(`${res.dryRun ? "DRY RUN" : "LAUNCHED"} [${rules.tier}] $${res.ticker} "${res.name}" pic:${res.picture} ${res.page || res.mint} (${res.postAgeSeconds}s after ${item.source} post${copy ? `, copy ${copy + 1}` : ""})`);
            if (!res.dryRun && res.devBuySol > 0) runExit(cfg, wallet, res.mint, log);
          }
          if (rules.relaunch && !cfg.dryRun) relaunchLoop(cfg, wallet, item.id, log);
        }
      }
    } catch (e) {
      markSeen(item.id);
      log(`error on ${item.url || item.id}: ${e.message.split("\n")[0]}`);
    }
    busy = false;
    next();
  };
  const push = (item) => {
    queue.push(item);
    next();
  };
  feed.on("item", push);
  feed.on("status", (s) => log(s));
  trend?.on("trend", async (t) => {
    log(`trend: "${t.name}" launched ${t.launches}x by ${t.devs} devs in ${cfg.sources.trend.windowMinutes} min`);
    push(await trendToItem(t));
  });
  trend?.on("status", (s) => log(`trend: ${s}`));
  return {
    feed,
    start: async () => {
      trend?.start();
      try {
        await feed.start();
      } catch (e) {
        if (!trend) throw e;
        log(e.message);
      }
    },
    stop: () => {
      feed.stop();
      trend?.stop();
    },
  };
}
