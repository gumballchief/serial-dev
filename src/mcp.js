// MCP server: plug serial-dev into Claude Code, Cursor, Codex, OpenClaw, any MCP agent.
// The agent brings the judgment (which post, what name, which picture). This server brings speed and the chain.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KEYS, loadConfig, setConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { draftCoin } from "./draft.js";
import * as engine from "./engine.js";
import { checkItem, rulesFor } from "./guards.js";
import { editPrompt, generateImage, generatorFor, imageCandidates, imagePrompt, saveImage, thumbnail } from "./images.js";
import { summarize } from "./ledger.js";
import * as pump from "./pump.js";
import { Feed, velocity } from "./sources.js";
import { TrendWatcher, trendToItem } from "./trend.js";
import { loadWallet } from "./wallet.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const text = (data) => ({ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) });
const ok = (data, images = []) => ({ content: [text(data), ...images] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `error: ${e.message}` }] });
const wrap = (fn) => async (args) => {
  try {
    const r = await fn(args || {});
    return r && r.__images ? ok(r.data, r.__images) : ok(r);
  } catch (e) {
    return fail(e);
  }
};

// Live feed: every enabled source + the pump.fun trend watcher, buffered for next_items.
let feed = null;
let trend = null;
const inbox = [];
const recent = new Map(); // id -> item, so later tools can refer to a post by id
const feedLog = [];
const logLine = (s) => feedLog.push(`${new Date().toISOString().slice(11, 19)} ${s}`) && feedLog.length > 200 && feedLog.shift();
function remember(item) {
  recent.set(item.id, item);
  if (recent.size > 1000) recent.delete(recent.keys().next().value);
  inbox.push(item);
  if (inbox.length > 500) inbox.shift();
}
function ensureFeed(cfg) {
  if (!feed) {
    feed = new Feed(cfg);
    feed.on("item", remember);
    feed.on("status", logLine);
    feed.start().catch((e) => {
      logLine(`error: ${e.message}`);
      feed = null;
    });
  }
  if (!trend && cfg.sources.trend?.enabled) {
    trend = new TrendWatcher(cfg);
    trend.on("status", (s) => logLine(`trend: ${s}`));
    trend.on("trend", async (t) => remember(await trendToItem(t)));
    trend.start();
  }
}
function resetFeed() {
  feed?.stop();
  trend?.stop();
  feed = trend = null;
}

// A post by link, tweet id, or an id from next_items.
async function itemFor(ref, cfg) {
  if (recent.has(ref)) return recent.get(ref);
  return engine.resolveTweet(ref, cfg);
}

const postArg = z.string().describe("Tweet link, tweet id, or an item id from next_items (Truth/news/trend posts)");

export async function startMcp() {
  const server = new McpServer(
    { name: "serial-dev", version: pkg.version },
    {
      instructions: [
        "serial-dev turns posts (X, Truth Social, news, pump.fun trends) into pump.fun coins in seconds.",
        "First call setup_check. It says what works, what's missing and the exact steps for each missing piece.",
        "If something is missing, tell your human in plain words what to get and why (setup_check gives the wording).",
        "Ask them to save keys themselves by running `serial-dev keys set <name>` in their own terminal, so keys never pass through chat.",
        "Then read_playbook once before launching. Network is devnet until a human switches it.",
      ].join(" "),
    }
  );

  server.registerTool(
    "setup_check",
    {
      description:
        "Run this first. Checks the dev wallet, its SOL, the Solana connection and every API key (Pinata, twitterapi.io, fal/OpenAI, RPC, Brave), says what works right now, what doesn't, and the exact next steps to give your human. Never returns key values.",
    },
    wrap(async () => {
      const d = await doctor(loadConfig());
      return {
        ...d,
        keyGuide: Object.fromEntries(
          Object.entries(KEYS)
            .filter(([n]) => !d.keys[n].set || /rejected/.test(d.keys[n].status))
            .map(([n, k]) => [n, { need: k.need, unlocks: k.unlocks, without: k.without, howToGet: k.get, link: k.url, save: `serial-dev keys set ${n}   (or env var ${k.env})` }])
        ),
      };
    })
  );

  server.registerTool(
    "read_playbook",
    { description: "Read the serial-dev playbook: what real serial devs launch (measured on-chain), speed, naming, pictures, relaunches, exits. Read once before launching." },
    wrap(async () => fs.readFileSync(path.join(ROOT, "PLAYBOOK.md"), "utf8"))
  );

  server.registerTool(
    "wallet_status",
    { description: "Dev wallet address, SOL balance and network (devnet or mainnet), plus limits, tiers and which sources are on." },
    wrap(async () => {
      const cfg = loadConfig();
      return {
        ...(await pump.walletStatus(cfg, loadWallet())),
        devBuySol: cfg.devBuySol,
        limits: cfg.limits,
        relaunch: cfg.relaunch,
        image: { mode: cfg.image.mode, generator: generatorFor(cfg) || "none (set FAL_KEY or OPENAI_API_KEY for GPT Image)" },
        sources: Object.fromEntries(Object.entries(cfg.sources).map(([k, v]) => [k, v.enabled])),
        watching: cfg.watch.accounts.map((h) => `${h} [${cfg.watch.tiers[h.toLowerCase()] || "A"}]`),
      };
    })
  );

  const nextItemsSchema = {
    max: z.number().int().min(1).max(50).optional(),
    wait_seconds: z.number().min(0).max(55).optional().describe("Wait up to this long if nothing is queued"),
  };
  let nextItems;
  server.registerTool(
    "next_items",
    {
      description:
        "Live feed from every source that's on (X accounts, Truth Social, news headlines, viral posts, names trending on pump.fun). Returns new posts since your last call, each with its tier, a coin draft, a filter verdict and picture hints. Loop: next_items -> pick -> image_options (if no picture) -> launch_coin.",
      inputSchema: nextItemsSchema,
    },
    (nextItems = wrap(async ({ max = 10, wait_seconds = 20 }) => {
      const cfg = loadConfig();
      ensureFeed(cfg);
      const until = Date.now() + wait_seconds * 1000;
      while (!inbox.length && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
      const batch = inbox.splice(0, max);
      return {
        items: batch.map((it) => {
          const rules = rulesFor(it, cfg);
          return {
            id: it.id,
            source: it.source,
            tier: rules.tier,
            post: { url: it.url, text: it.text, author: it.author?.handle || it.author?.name, followers: it.author?.followers, likes: it.likes, likesPerMin: velocity(it), pictures: it.media?.length || 0, links: it.links?.length || 0 },
            ...(it.trend ? { trend: it.trend } : {}),
            ageSeconds: Math.round((Date.now() - it.createdAt) / 1000),
            filters: checkItem(it, cfg, rules) || "pass",
            draft: draftCoin(it, cfg, it.suggested || {}),
          };
        }),
        stillQueued: inbox.length,
        feed: feedLog.slice(-6),
      };
    }))
  );

  server.registerTool(
    "next_tweets",
    { description: "Same as next_items (kept for older prompts).", inputSchema: nextItemsSchema },
    (a) => nextItems(a)
  );

  server.registerTool(
    "draft_coin",
    {
      description: "Turn a post into a coin draft (name, ticker, description) and say whether the filters allow it. Free, nothing launches.",
      inputSchema: { post: postArg, name: z.string().max(32).optional(), ticker: z.string().max(13).optional() },
    },
    wrap(async ({ post, ...o }) => {
      const cfg = loadConfig();
      const it = await itemFor(post, cfg);
      const rules = rulesFor(it, cfg);
      return { tier: rules.tier, draft: draftCoin(it, cfg, { ...(it.suggested || {}), ...o }), filters: checkItem(it, cfg, rules) || "pass", ageSeconds: Math.round((Date.now() - it.createdAt) / 1000) };
    })
  );

  server.registerTool(
    "image_options",
    {
      description:
        "Every picture option for a post, shown to you as images: the post's own picture, quoted/replied-to/linked posts, linked pages, Wikipedia, image search. Rule from 678 real launches: the picture IS the name. Use the real picture of the subject as it is when one exists; only when nothing real exists, generate_image(promptFromScratch) draws the name, literally or as a pun.",
      inputSchema: { post: postArg, name: z.string().optional(), ticker: z.string().optional() },
    },
    wrap(async ({ post, name, ticker }) => {
      const cfg = loadConfig();
      const it = await itemFor(post, cfg);
      const draft = draftCoin(it, cfg, { ...(it.suggested || {}), name, ticker });
      const options = (await imageCandidates(it, draft, cfg)).slice(0, 6);
      const images = [];
      const listed = [];
      for (const [i, c] of options.entries()) {
        try {
          images.push({ type: "image", mimeType: "image/jpeg", data: (await thumbnail(c.url)).toString("base64") });
          listed.push({ option: i + 1, ...c });
        } catch {
          listed.push({ option: i + 1, ...c, preview: "couldn't load" });
        }
      }
      return {
        __images: images,
        data: {
          coin: `${draft.name} ($${draft.ticker})`,
          options: listed,
          note: "Images below are in the same order as options (skipping any that couldn't load).",
          generator: generatorFor(cfg) || "none (set FAL_KEY or OPENAI_API_KEY for GPT Image)",
          promptFromScratch: imagePrompt(it, draft),
          promptToRemixAnOption: editPrompt(it, draft),
        },
      };
    })
  );

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate a coin picture with ChatGPT's image model (GPT Image). Use it only when no real picture of the subject exists; the prompt should draw the coin's name, literally or as a pun. reference_url optionally starts from a real picture. Returns a file path to pass as launch_coin's image, and shows you the result.",
      inputSchema: {
        prompt: z.string().min(10),
        reference_url: z.string().url().optional(),
      },
    },
    wrap(async ({ prompt, reference_url }) => {
      const cfg = loadConfig();
      const reference = reference_url ? Buffer.from(await (await fetch(reference_url)).arrayBuffer()) : undefined;
      const buf = await generateImage(prompt, cfg, { reference });
      const file = saveImage(buf);
      return { __images: [{ type: "image", mimeType: "image/jpeg", data: (await thumbnail(buf)).toString("base64") }], data: { image: file, provider: generatorFor(cfg) } };
    })
  );

  server.registerTool(
    "launch_coin",
    {
      description:
        "Launch a pump.fun coin from a post (name/ticker/picture are drafted from it; override any) or from a bare name + ticker + image. Without an image it picks one the smart way (post picture, else generated, else best free option). copies > 1 launches several coins of the same post right away, each with a different picture. Spends real SOL on mainnet; dry_run simulates.",
      inputSchema: {
        post: postArg.optional(),
        name: z.string().max(32).optional(),
        ticker: z.string().max(13).optional(),
        image: z.string().optional().describe("Image URL, or a file path from generate_image"),
        description: z.string().max(500).optional(),
        uri: z.string().url().optional().describe("Ready metadata JSON link, skips uploading"),
        dev_buy_sol: z.number().min(0).optional().describe("Your call. SOL to buy in the launch transaction. 0 = no buy: this kit creates the coin on chain from your wallet right away (unlike pump.fun's website, where a no-buy coin stays off chain and hidden until someone's first buy deploys it, and that buyer shows as the on-chain deployer); it shows Dev 0% and an empty chart until someone trades. 0.05 = ~0.18% of supply, 0.1 = ~0.35%, 1 = ~3.4%, 10 = ~27%; the buy is public (dev holds X%). Default 0.1 if you leave it out; capped by limits.maxDevBuySol. Holding or selling it later is also your call (sell tool)."),
        copies: z.number().int().min(1).max(5).optional(),
        holder_reward: z.boolean().optional().describe("Creator fees go to holders instead of you (mainnet only)"),
        force: z.boolean().optional().describe("Skip filters and rate limits"),
        dry_run: z.boolean().optional(),
      },
    },
    wrap(async (a) => {
      const cfg = loadConfig();
      if (a.dry_run) cfg.dryRun = true;
      const cap = Number(cfg.limits.maxDevBuySol ?? 0.5);
      if (a.dev_buy_sol !== undefined && a.dev_buy_sol > cap) throw new Error(`dev_buy_sol ${a.dev_buy_sol} is over this wallet's cap of ${cap} SOL (limits.maxDevBuySol, set by the human).`);
      const wallet = loadWallet();
      const opts = { name: a.name, ticker: a.ticker, image: a.image, description: a.description, uri: a.uri, devBuySol: a.dev_buy_sol, holderReward: a.holder_reward, force: a.force };
      const first = a.post ? await engine.launchItem(cfg, wallet, await itemFor(a.post, cfg), opts) : await engine.launchCoin(cfg, wallet, opts);
      const out = [first];
      for (let i = 1; i < (a.copies || 1) && first.launched; i++) out.push(await engine.relaunch(cfg, wallet, first.mint, { devBuySol: a.dev_buy_sol }));
      return out.length > 1 ? out : first;
    })
  );

  server.registerTool(
    "relaunch",
    {
      description: "Launch another copy of a coin's post: same name, ticker and picture (real serial devs keep the picture on 33 of 37 relaunches). Do it when the first copy dies young; sometimes copy 3 is the one that runs.",
      inputSchema: { mint: z.string(), image: z.string().optional(), new_picture: z.boolean().optional().describe("Pick a different picture this time"), dry_run: z.boolean().optional() },
    },
    wrap(async ({ mint, image, new_picture, dry_run }) => {
      const cfg = loadConfig();
      if (dry_run) cfg.dryRun = true;
      return engine.relaunch(cfg, loadWallet(), mint, { image, newPicture: new_picture });
    })
  );

  server.registerTool(
    "watch_list",
    {
      description: "See or change which X accounts and keywords are watched, and each account's tier (S = coin everything they post, A = only posts with a picture, news = headlines).",
      inputSchema: {
        add: z.array(z.string()).optional(),
        tier: z.enum(["S", "A", "news"]).optional().describe("Tier for the accounts in add"),
        remove: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional().describe("Replaces the keyword list"),
      },
    },
    wrap(async ({ add, tier, remove, keywords }) => {
      let cfg = loadConfig();
      const clean = (h) => h.replace(/^@/, "").trim();
      if (add?.length) {
        cfg = setConfig("watch.accounts", [...new Set([...cfg.watch.accounts, ...add.map(clean)])]);
        if (tier) cfg = setConfig("watch.tiers", { ...cfg.watch.tiers, ...Object.fromEntries(add.map((h) => [clean(h).toLowerCase(), tier])) });
      }
      if (remove?.length) cfg = setConfig("watch.accounts", cfg.watch.accounts.filter((x) => !remove.map(clean).includes(x)));
      if (keywords) cfg = setConfig("watch.keywords", keywords);
      if (add || remove || keywords) resetFeed();
      return { accounts: cfg.watch.accounts.map((h) => `${h} [${cfg.watch.tiers[h.toLowerCase()] || "A"}]`), keywords: cfg.watch.keywords };
    })
  );

  server.registerTool(
    "sources",
    {
      description: "Turn feeds on or off: x (watched accounts), truth (Trump's Truth Social), news (headlines), viral (X posts blowing up), trend (names several devs are launching on pump.fun right now).",
      inputSchema: { set: z.object({ x: z.boolean().optional(), truth: z.boolean().optional(), news: z.boolean().optional(), viral: z.boolean().optional(), trend: z.boolean().optional() }).optional() },
    },
    wrap(async ({ set }) => {
      let cfg = loadConfig();
      for (const [k, v] of Object.entries(set || {})) cfg = setConfig(`sources.${k}.enabled`, v);
      if (set) resetFeed();
      return Object.fromEntries(Object.entries(cfg.sources).map(([k, v]) => [k, { on: v.enabled, tier: v.tier }]));
    })
  );

  server.registerTool(
    "coin_status",
    { description: "Market cap (SOL), bonding-curve progress, graduated or not, your bag, unswept creator fees.", inputSchema: { mint: z.string() } },
    wrap(async ({ mint }) => pump.coinStatus(loadConfig(), mint, loadWallet().publicKey))
  );

  server.registerTool(
    "buy",
    { description: "Buy a coin with SOL (curve or PumpSwap after graduation).", inputSchema: { mint: z.string(), sol: z.number().positive(), dry_run: z.boolean().optional() } },
    wrap(async ({ mint, sol, dry_run }) => {
      const cfg = loadConfig();
      if (dry_run) cfg.dryRun = true;
      return engine.buyCoin(cfg, loadWallet(), mint, sol);
    })
  );

  server.registerTool(
    "sell",
    { description: "Sell a percent of your bag in a coin.", inputSchema: { mint: z.string(), percent: z.number().min(1).max(100).default(100), dry_run: z.boolean().optional() } },
    wrap(async ({ mint, percent, dry_run }) => {
      const cfg = loadConfig();
      if (dry_run) cfg.dryRun = true;
      return engine.sellCoin(cfg, loadWallet(), mint, percent);
    })
  );

  server.registerTool("creator_fees", { description: "Creator fees waiting across all your coins (SOL)." }, wrap(async () => engine.fees(loadConfig(), loadWallet())));
  server.registerTool("claim_fees", { description: "Collect creator fees into the dev wallet. Skips if less than limits.claimMinSol (0.005) is waiting, since each claim costs fees; force: true claims anyway. The very first claim also opens a one-time ~0.002 SOL account for fees from coins that graduate.", inputSchema: { force: z.boolean().optional() } }, wrap(async ({ force }) => engine.claim(loadConfig(), loadWallet(), { force })));

  server.registerTool(
    "review",
    {
      description: "What's working: your recent launches grouped by source, tier, account and picture type, with how much SOL is in each coin's curve now. Use it to drop accounts and habits that never pull volume.",
      inputSchema: { hours: z.number().min(1).max(720).optional() },
    },
    wrap(async ({ hours = 24 }) => engine.review(loadConfig(), { hours }))
  );

  server.registerTool("stats", { description: "Track record on this network: launches (hour/day/all), SOL spent, sold, fees claimed, net." }, wrap(async () => summarize(loadConfig().network)));

  await server.connect(new StdioServerTransport());
}
