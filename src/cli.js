import readline from "node:readline";
import { FILES, HOME, KEYS, keySources, loadConfig, readFileConfig, saveKey, setConfig } from "./config.js";
import { doctor, formatDoctor } from "./doctor.js";
import { draftCoin } from "./draft.js";
import * as engine from "./engine.js";
import { summarize } from "./ledger.js";
import * as pump from "./pump.js";
import { editPrompt, generateImage, imageCandidates, imagePrompt, saveImage } from "./images.js";
import { getTweet } from "./tweets.js";
import { createWallet, loadWallet } from "./wallet.js";

const HELP = `serial-dev: turn tweets into pump.fun coins in seconds.

Setup
  init                         make the dev wallet + config (mainnet by default), then the setup check
  doctor                       what works, what's missing, and the exact next step
  keys                         every API key: what it unlocks, where to get it, which are set
  keys set <name>              save a key (asks for it hidden). Names: ${Object.keys(KEYS).join(", ")}
  keys remove <name>
  wallet                       address and SOL balance
  airdrop [sol]                devnet test SOL (if the faucet is open)
  config [key] [value]         show or change settings, e.g. config devBuySol 0.1
  config network devnet        practice with free test SOL (config network mainnet to go back).
                               Only a human should switch networks.

One coin
  tweet <link>                 read a tweet
  draft <link>                 see the coin a tweet would become
  images <link> [--generate]   every picture option for it (and a generated one)
  launch <link> [options]      launch it
      --name "..." --ticker XYZ --image <url or file> --uri <metadata url>
      --buy <sol>              dev buy in the same transaction (default: config devBuySol)
      --copies <n>             launch n copies right away (different picture each)
      --force                  skip the filters and limits
      --dry-run                simulate on chain, spend nothing
  launch --name "..." --ticker XYZ --image <url>     launch without a tweet
  relaunch <mint> [--new-picture]   another copy of that coin's post (same picture unless --new-picture)

Autopilot
  watch add <handles...> [--tier S|A|news]   accounts to watch (S = coin everything they post)
  watch remove <handles...>
  watch keywords <words...>    also catch posts with these words
  watch list
  sources                      what's feeding the autopilot
  sources <truth|news|viral|trend|x> <on|off>
  run [--dry-run]              watch everything and launch what passes the checks
  review [--hours 24]          which sources, accounts and pictures pull money

Money
  coin <mint>                  market cap, bonding progress, your bag
  buy <mint> <sol>
  sell <mint> [percent]
  fees                         creator fees waiting for you
  claim                        collect them
  stats                        launches, spend, sells, fees, net

Add --json to any command for machine-readable output.
Files live in ${HOME}`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith("--")) {
        flags[key] = nxt;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

// Hidden prompt for keys. Masks every redraw too (Backspace, wrapping, resize), not just typing.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    rl.question(question, (ans) => {
      rl._writeToOutput = orig;
      rl.close();
      process.stdout.write("\n");
      resolve(ans);
    });
    rl._writeToOutput = (str) => {
      if (str.startsWith(question)) orig(question + "*".repeat(rl.line.length));
      else if (str !== "\r\n") orig("*".repeat(str.length));
    };
  });
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function print(data, json) {
  if (json || typeof data !== "object" || data === null) return console.log(json ? JSON.stringify(data, null, 2) : data);
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `  ${k.padEnd(20)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  console.log(lines.join("\n"));
}

export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  const json = !!flags.json;
  const cfg = loadConfig();
  if (flags["dry-run"]) cfg.dryRun = true;

  switch (cmd) {
    case undefined:
    case "help":
      return console.log(HELP);

    case "init": {
      const { keypair, created } = createWallet();
      if (!Object.keys(readFileConfig()).length) setConfig("network", "mainnet");
      const status = await pump.walletStatus(loadConfig(), keypair).catch(() => ({ address: keypair.publicKey.toBase58() }));
      if (json) return print({ wallet: created ? "created" : "already exists", ...status, walletFile: FILES.wallet, config: FILES.config, setup: await doctor(loadConfig()) }, true);
      console.log(`Dev wallet ${created ? "created" : "already exists"}: ${status.address}`);
      console.log(`Saved at ${FILES.wallet} (back this file up; it is the wallet).\n`);
      return console.log(formatDoctor(await doctor(loadConfig())));
    }

    case "doctor":
    case "setup": {
      const d = await doctor(cfg);
      return json ? print(d, true) : console.log(formatDoctor(d));
    }

    case "keys": {
      const [sub, name, ...val] = rest;
      if (sub === "set" || sub === "remove") {
        if (!KEYS[name]) throw new Error(`Which key? serial-dev keys ${sub} <${Object.keys(KEYS).join("|")}>`);
        let value = "";
        if (sub === "set") {
          if (val.length) value = val.join(" ");
          else if (process.stdin.isTTY) {
            console.log(`${name}: ${KEYS[name].unlocks}\nGet it: ${KEYS[name].get}\n`);
            value = await askHidden(`Paste your ${name} ${name === "rpc" ? "URL" : "key"} (hidden): `);
          } else value = await readStdin();
          if (!value.trim()) throw new Error("Nothing entered, nothing saved.");
        }
        saveKey(name, value);
        if (sub === "remove") return print({ removed: name }, json);
        const k = (await doctor(loadConfig())).keys[name];
        return print({ saved: name, status: k.status, file: FILES.keys, ...(keySources()[name] === "env" ? { note: `The ${KEYS[name].env} env var is also set and wins over the saved key.` } : {}) }, json);
      }
      const src = keySources();
      if (json) return print(Object.fromEntries(Object.entries(KEYS).map(([n, k]) => [n, { set: !!src[n], from: src[n], ...k }])), true);
      for (const [n, k] of Object.entries(KEYS)) {
        console.log(`${src[n] ? "[ok]" : "[--]"} ${n}  (${k.need})${src[n] ? `  set via ${src[n] === "env" ? k.env : "saved keys"}` : ""}`);
        console.log(`     ${k.unlocks}`);
        if (!src[n]) console.log(`     Without it: ${k.without}\n     Get it: ${k.get}\n     Save it: serial-dev keys set ${n}   (or env var ${k.env})`);
        console.log("");
      }
      return;
    }

    case "wallet":
      return print(await pump.walletStatus(cfg, loadWallet()), json);

    case "airdrop":
      return print(await pump.airdrop(cfg, loadWallet(), Number(rest[0]) || 1), json);

    case "config": {
      if (rest[0] === "network" && rest[1] === "mainnet") console.log("Switching to MAINNET: launches now spend real SOL.");
      if (rest.length >= 2) {
        const updated = setConfig(rest[0], rest.slice(1).join(" "));
        return print({ [rest[0]]: rest[0].split(".").reduce((o, k) => o?.[k], updated) }, json);
      }
      const { keys, ...shown } = cfg;
      const view = rest[0] ? rest[0].split(".").reduce((o, k) => o?.[k], shown) : shown;
      return console.log(JSON.stringify(view, null, 2));
    }

    case "tweet":
      return print(await getTweet(rest[0], cfg), true);

    case "draft": {
      const t = await getTweet(rest[0], cfg);
      return print(draftCoin(t, cfg, { name: flags.name, ticker: flags.ticker, image: flags.image }), json);
    }

    case "launch": {
      const wallet = loadWallet();
      const opts = {
        tweet: rest[0],
        name: flags.name,
        ticker: flags.ticker,
        image: flags.image,
        uri: flags.uri,
        description: flags.description,
        devBuySol: flags.buy !== undefined ? Number(flags.buy) : undefined,
        force: !!flags.force,
      };
      const first = await engine.launchCoin(cfg, wallet, opts);
      const results = [first];
      for (let i = 1; i < (Number(flags.copies) || 1) && !first.skipped; i++) {
        if (first.dryRun) break;
        results.push(await engine.relaunch(cfg, wallet, first.mint, { devBuySol: opts.devBuySol }));
      }
      return results.length > 1 ? print(results, true) : print(first, json);
    }

    case "relaunch":
      return print(await engine.relaunch(cfg, loadWallet(), rest[0], { devBuySol: flags.buy !== undefined ? Number(flags.buy) : undefined, newPicture: !!flags["new-picture"] }), json);

    case "images": {
      const item = await engine.resolveTweet(rest[0], cfg);
      const draft = draftCoin(item, cfg, { name: flags.name, ticker: flags.ticker });
      const options = await imageCandidates(item, draft, cfg);
      const out = { coin: `${draft.name} (${draft.ticker})`, options, prompt: imagePrompt(item, draft) };
      if (flags.generate) {
        const ref = options.find((c) => c.how !== "post" && c.how !== "wikipedia");
        const buf = ref
          ? await generateImage(editPrompt(item, draft), cfg, { reference: Buffer.from(await (await fetch(ref.url)).arrayBuffer()) })
          : await generateImage(imagePrompt(item, draft), cfg);
        out.generated = saveImage(buf);
        out.generatedFrom = ref ? ref.how : "prompt only";
      }
      return print(out, true);
    }

    case "sources": {
      const [name, onoff] = rest;
      if (name && onoff) setConfig(`sources.${name}.enabled`, onoff === "on" ? "true" : "false");
      const s2 = loadConfig();
      const keyed = { x: !!s2.keys.twitterapi, viral: !!s2.keys.twitterapi, truth: true, news: true, trend: true };
      return print(
        Object.fromEntries(Object.entries(s2.sources).map(([k, v]) => [k, `${v.enabled ? "ON " : "off"}  tier ${v.tier || "-"}${keyed[k] ? "" : "  (needs TWITTERAPI_KEY)"}`])),
        json
      );
    }

    case "review":
      return print(await engine.review(cfg, { hours: Number(flags.hours) || 24 }), true);

    case "watch": {
      const [sub, ...items] = rest;
      const clean = (h) => h.replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//, "").trim();
      if (sub === "add") {
        setConfig("watch.accounts", [...new Set([...cfg.watch.accounts, ...items.map(clean)])]);
        if (flags.tier) setConfig("watch.tiers", { ...cfg.watch.tiers, ...Object.fromEntries(items.map((h) => [clean(h).toLowerCase(), String(flags.tier)])) });
      }
      else if (sub === "remove") setConfig("watch.accounts", cfg.watch.accounts.filter((a) => !items.map(clean).includes(a)));
      else if (sub === "keywords") setConfig("watch.keywords", items);
      const now = loadConfig().watch;
      const tierOfH = (h) => now.tiers[h.toLowerCase()] || "A";
      return print({ accounts: now.accounts.map((h) => `${h} [${tierOfH(h)}]`).join(", ") || "(none)", keywords: now.keywords.join(", ") || "(none)", mode: now.mode }, json);
    }

    case "run": {
      const wallet = loadWallet();
      const w = await pump.walletStatus(cfg, wallet);
      console.log(`serial-dev autopilot on ${cfg.network.toUpperCase()}${cfg.dryRun ? " (DRY RUN, nothing is spent)" : ""}`);
      console.log(`wallet ${w.address}  ${w.sol} SOL  dev buy ${cfg.devBuySol} SOL  limit ${cfg.limits.maxLaunchesPerHour}/hour, ${cfg.limits.maxSolPerDay} SOL/day`);
      if (cfg.devBuySol > 0 && !cfg.dryRun) await pump.lookupTable(cfg, wallet);
      const stamp = () => new Date().toLocaleTimeString();
      const pilot = engine.autopilot(cfg, wallet, { log: (m) => console.log(`[${stamp()}] ${m}`) });
      await pilot.start();
      process.on("SIGINT", () => {
        pilot.stop();
        console.log("\nstopped.");
        process.exit(0);
      });
      return new Promise(() => {});
    }

    case "coin": {
      const wallet = (() => {
        try {
          return loadWallet();
        } catch {
          return null;
        }
      })();
      return print(await pump.coinStatus(cfg, rest[0], wallet?.publicKey), json);
    }

    case "buy":
      return print(await engine.buyCoin(cfg, loadWallet(), rest[0], Number(rest[1])), json);

    case "sell":
      return print(await engine.sellCoin(cfg, loadWallet(), rest[0], Number(rest[1]) || 100), json);

    case "fees":
      return print(await engine.fees(cfg, loadWallet()), json);

    case "claim":
      return print(await engine.claim(cfg, loadWallet(), { force: !!flags.force }), json);

    case "stats":
      return print(summarize(cfg.network), json);

    default:
      console.log(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}
