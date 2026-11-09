import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.SERIAL_DEV_HOME || path.join(os.homedir(), ".serial-dev");

export const FILES = {
  config: path.join(HOME, "config.json"),
  wallet: process.env.SERIAL_DEV_WALLET || path.join(HOME, "wallet.json"),
  ledger: path.join(HOME, "ledger.jsonl"),
  seen: path.join(HOME, "seen.json"),
  // API keys saved with `serial-dev keys set`. Never in the repo. Env vars win over this file.
  keys: path.join(HOME, "keys.json"),
};

// Every outside service the kit can use: what it unlocks, what happens without it, where to get it.
// `serial-dev doctor` and the setup_check tool read this, so humans and agents see the same list.
export const KEYS = {
  pinata: {
    env: "PINATA_JWT",
    field: "pinataJwt",
    need: "required to launch",
    unlocks: "Hosts each coin's picture and info so the coin shows its picture on pump.fun.",
    without: "Launches stop with an error (unless you pass your own --uri metadata link).",
    get: "pinata.cloud > sign up (free plan) > API Keys > New Key > Admin > Create > copy the JWT.",
    url: "https://app.pinata.cloud/developers/api-keys",
  },
  twitterapi: {
    env: "TWITTERAPI_KEY",
    field: "twitterapi",
    need: "for autopilot on X",
    unlocks: "Watches X accounts live (Elon etc.) and finds viral posts, so coins launch seconds after a post.",
    without: "You can still launch from any tweet link, and the Truth Social, news and pump.fun trend feeds are free.",
    get: "twitterapi.io > sign in > copy the API key on the dashboard. New accounts get ~$1 of free credits (100,000; expire after 31 days), then pay as you go: 15 credits per post from accounts you watch.",
    url: "https://twitterapi.io/dashboard",
  },
  fal: {
    env: "FAL_KEY",
    field: "fal",
    need: "optional",
    unlocks: "Draws a picture with ChatGPT's image model (GPT Image) when no real picture of the subject exists.",
    without: "Real pictures only (post, profile, linked page, search), then a plain text card.",
    get: "fal.ai > sign in > Dashboard > Keys > Add key > copy it. Or set the OpenAI key instead.",
    url: "https://fal.ai/dashboard/keys",
  },
  openai: {
    env: "OPENAI_API_KEY",
    field: "openai",
    need: "optional",
    unlocks: "Same as fal: GPT Image pictures, straight from OpenAI. Only one of fal or openai is needed.",
    without: "Real pictures only, then a plain text card.",
    get: "platform.openai.com > API keys > Create new secret key > copy it.",
    url: "https://platform.openai.com/api-keys",
  },
  rpc: {
    env: "SOLANA_RPC_URL",
    field: "rpc",
    need: "recommended for mainnet",
    unlocks: "A private Solana connection: faster launches and no rate limits when you launch a lot.",
    without: "Uses Solana's free public connection, which is slower and throttles bursts.",
    get: "helius.dev > sign up (free plan) > copy the mainnet RPC URL (it has your key in it).",
    url: "https://dashboard.helius.dev",
  },
  brave: {
    env: "BRAVE_API_KEY",
    field: "brave",
    need: "optional",
    unlocks: "Image search, used for news coins when the article has no usable picture.",
    without: "News coins use the article picture or Wikipedia, then a text card.",
    get: "api-dashboard.search.brave.com > sign up (free plan) > API Keys > copy it.",
    url: "https://api-dashboard.search.brave.com/app/keys",
  },
};

export function readSavedKeys() {
  try {
    return JSON.parse(fs.readFileSync(FILES.keys, "utf8"));
  } catch {
    return {};
  }
}

export function saveKey(name, value) {
  if (!KEYS[name]) throw new Error(`Unknown key "${name}". Known: ${Object.keys(KEYS).join(", ")}`);
  ensureHome();
  const saved = readSavedKeys();
  const v = String(value ?? "").trim().replace(/^["']|["']$/g, "");
  if (v) saved[name] = v;
  else delete saved[name];
  fs.writeFileSync(FILES.keys, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return !!v;
}

// Where each key comes from right now: "env", "saved" or null. Never the value itself.
export function keySources(env = process.env) {
  const saved = readSavedKeys();
  return Object.fromEntries(
    Object.entries(KEYS).map(([name, k]) => [name, (name === "fal" ? falKey(env) : env[k.env]) ? "env" : saved[name] ? "saved" : null])
  );
}

export const DEFAULTS = {
  // devnet until a human flips it. Agents can't change this through MCP.
  network: "devnet",
  rpcUrl: "",
  // Used only when the agent doesn't choose. How much to buy (0 included) is the agent's call;
  // PLAYBOOK.md section 9 tells it what each amount does.
  devBuySol: 0.1,
  slippagePct: 15,
  priorityFeeMicroLamports: 200000,
  computeUnits: 400000,
  coin: {
    // Adds "Tweet coin. Not affiliated with @handle." to every description.
    notAffiliated: true,
    website: "",
    telegram: "",
  },
  filters: {
    requireMedia: true,
    skipReplies: true,
    skipRetweets: true,
    minAuthorFollowers: 0,
    minLikes: 0,
    maxTweetAgeSeconds: 120,
    blockWords: ["rip", "passed away", "died", "killed", "shooting", "victims", "condolences", "funeral", "pray for"],
  },
  limits: {
    // Biggest dev buy an agent may ask for through MCP.
    maxDevBuySol: 0.5,
    // Optional floor for the dev buy. 0 = no floor (the agent decides, no-buy launches allowed).
    minDevBuySol: 0,
    maxLaunchesPerHour: 20,
    // Counts dev buys too (you get most of that back when you sell).
    maxSolPerDay: 5,
    // Don't claim fees until at least this much is waiting (each claim costs fees; the first also opens
    // a one-time ~0.002 SOL account for fees from graduated coins).
    claimMinSol: 0.005,
    cooldownSeconds: 5,
  },
  exit: {
    // What happens to the dev bag. Both 0 = hold it (default). Sell after N seconds, or at N x market cap.
    takeProfitX: 0,
    sellAfterSeconds: 0,
    sellPct: 100,
  },
  watch: {
    accounts: [],
    // handle -> tier. Unlisted accounts are tier A.
    tiers: {},
    keywords: [],
    // How often twitterapi.io checks the watched accounts. Tested 11/2026: at 5 s new posts arrive ~8-10 s
    // after posting and you pay 15 credits per post. Below 5 s it re-sends the newest post every check and
    // bills each one (~54k credits/hour at 1 s), so the kit never goes under 5.
    intervalSeconds: 5,
    mode: "stream",
  },
  // How hard to go on each kind of post. S = coin everything they say (Elon, Trump).
  tiers: {
    S: { requireMedia: false, skipReplies: false, copies: 1, relaunch: true, maxAgeSeconds: 180 },
    A: { requireMedia: true, skipReplies: true, copies: 1, relaunch: false, maxAgeSeconds: 120 },
    news: { requireMedia: false, skipReplies: true, copies: 1, relaunch: false, maxAgeSeconds: 1800 },
    viral: { requireMedia: true, skipReplies: true, copies: 1, relaunch: true, maxAgeSeconds: 3600 },
    trend: { requireMedia: false, skipReplies: false, copies: 1, relaunch: false, maxAgeSeconds: 600 },
  },
  // Same post, new coin, when the last one died young. Serial devs do this: sometimes copy 3 runs.
  relaunch: {
    maxCopies: 3,
    checkAfterSeconds: 90,
    // A copy counts as dead when less than this much SOL is in its curve at check time.
    deadBelowSol: 1,
    maxAgeMinutes: 20,
    // Keep the same picture on every copy (what 33 of 37 real relaunches did).
    samePicture: true,
  },
  image: {
    // smart: the real picture of the subject first (as devs do), GPT Image draws the name only when nothing real exists.
    // fast: never generate.
    mode: "smart",
    // auto = ChatGPT's image model (GPT Image 2.5): fal.ai if FAL_KEY is set, else OpenAI if OPENAI_API_KEY is set.
    // Gemini is only used if you set provider "gemini" yourself.
    provider: "auto",
    falModel: "openai/gpt-image-2.5/sunburst",
    openaiModel: "gpt-image-2.5-sunburst",
    geminiModel: "gemini-2.5-flash-image",
    // medium: ~20 s and close to high. high: ~50 s. low was no faster in tests and looked worse.
    quality: "medium",
    search: true,
  },
  sources: {
    x: { enabled: true },
    truth: { enabled: false, pollSeconds: 15, tier: "S" },
    news: { enabled: false, pollSeconds: 30, tier: "news", feeds: ["https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en"] },
    viral: { enabled: false, pollSeconds: 60, tier: "viral", minLikes: 5000, windowMinutes: 30, query: "" },
    // Names that several different devs are launching right now (free, reads pump.fun launches live).
    trend: { enabled: false, tier: "trend", windowMinutes: 5, minDevs: 3, wsUrl: "" },
  },
};

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
}

export function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILES.config, "utf8"));
  } catch {
    return {};
  }
}

// FAL_KEY, or FAL_KEY_FILE pointing at a file that holds it.
function falKey(env) {
  let k = env.FAL_KEY || "";
  if (!k && env.FAL_KEY_FILE) {
    try {
      k = fs.readFileSync(env.FAL_KEY_FILE, "utf8");
    } catch {}
  }
  return k.trim().replace(/^["']|["']$/g, "").replace(/^Key\s+/i, "");
}

export function loadConfig() {
  const cfg = merge(DEFAULTS, readFileConfig());
  const env = process.env;
  const saved = readSavedKeys();
  if (env.SERIAL_DEV_NETWORK) cfg.network = env.SERIAL_DEV_NETWORK;
  if (env.SOLANA_RPC_URL || saved.rpc) cfg.rpcUrl = env.SOLANA_RPC_URL || saved.rpc;
  cfg.keys = {
    twitterapi: env.TWITTERAPI_KEY || saved.twitterapi || "",
    pinataJwt: env.PINATA_JWT || saved.pinata || "",
    pinataGateway: (env.PINATA_GATEWAY || "https://gateway.pinata.cloud").replace(/\/$/, ""),
    fal: falKey(env) || saved.fal || "",
    openai: env.OPENAI_API_KEY || saved.openai || "",
    gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
    brave: env.BRAVE_API_KEY || saved.brave || "",
  };
  if (!["devnet", "mainnet"].includes(cfg.network)) throw new Error(`network must be devnet or mainnet, got "${cfg.network}"`);
  return cfg;
}

function coerce(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return raw;
}

// setConfig("limits.maxLaunchesPerHour", "40")
export function setConfig(dotPath, rawValue) {
  ensureHome();
  const file = readFileConfig();
  const keys = dotPath.split(".");
  let node = file;
  for (const k of keys.slice(0, -1)) node = node[k] = isObj(node[k]) ? node[k] : {};
  node[keys.at(-1)] = typeof rawValue === "string" ? coerce(rawValue) : rawValue;
  fs.writeFileSync(FILES.config, JSON.stringify(file, null, 2));
  return loadConfig();
}

export function rpcFor(cfg) {
  if (cfg.rpcUrl) return cfg.rpcUrl;
  return cfg.network === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}

export function explorer(cfg, kind, id) {
  const suffix = cfg.network === "devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/${kind}/${id}${suffix}`;
}

export function coinPage(cfg, mint) {
  return cfg.network === "mainnet" ? `https://pump.fun/coin/${mint}` : explorer(cfg, "token", mint);
}
