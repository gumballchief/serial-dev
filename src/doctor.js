import fs from "node:fs";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { FILES, KEYS, keySources, rpcFor } from "./config.js";
import { loadWallet } from "./wallet.js";

// One look at everything a new user needs: wallet, SOL, connection, keys. Says what works right now
// and the exact next step. Used by `serial-dev doctor`, `serial-dev init` and the setup_check tool.

const MIN_LAUNCH_SOL = 0.01; // ~0.006 SOL to create a coin, plus room for fees

const timeout = (ms) => AbortSignal.timeout(ms);

// Cheap "is this key accepted?" calls. A key with no free check is reported as saved, not verified.
async function verify(name, cfg) {
  try {
    if (name === "pinata") {
      const r = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${cfg.keys.pinataJwt}` }, signal: timeout(8000) });
      return r.ok ? "works" : r.status === 401 || r.status === 403 ? "rejected" : `unclear (HTTP ${r.status})`;
    }
    if (name === "twitterapi") {
      const r = await fetch("https://api.twitterapi.io/oapi/my/info", { headers: { "x-api-key": cfg.keys.twitterapi }, signal: timeout(8000) });
      if (r.status === 401 || r.status === 403) return "rejected";
      const j = await r.json().catch(() => ({}));
      if (j.status === "error" && /key|auth/i.test(j.msg || j.message || "")) return "rejected";
      const paid = j.recharge_credits ?? j.data?.recharge_credits;
      const bonus = j.total_bonus_credits ?? j.data?.total_bonus_credits ?? 0;
      if (paid === undefined) return r.ok ? "works" : `unclear (HTTP ${r.status})`;
      const total = Number(paid) + Number(bonus);
      return `works (${total.toLocaleString("en-US")} credits${bonus ? `, ${Number(bonus).toLocaleString("en-US")} of them free` : ""})${total <= 0 ? " - top up at twitterapi.io to watch X" : ""}`;
    }
    if (name === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${cfg.keys.openai}` }, signal: timeout(8000) });
      return r.ok ? "works" : r.status === 401 ? "rejected" : `unclear (HTTP ${r.status})`;
    }
  } catch (e) {
    return `couldn't check (${e.name === "TimeoutError" ? "timed out" : e.message})`;
  }
  return "saved (checked on first use)";
}

export async function doctor(cfg, { offline = false } = {}) {
  const out = { network: cfg.network, wallet: null, sol: null, connection: null, keys: {}, works: [], blocked: [], next: [] };

  // Wallet
  let wallet = null;
  try {
    wallet = loadWallet();
    out.wallet = wallet.publicKey.toBase58();
  } catch {
    out.wallet = null;
  }

  // Connection + balance
  const rpc = rpcFor(cfg);
  const isPublic = /api\.(mainnet-beta|devnet)\.solana\.com/.test(rpc);
  if (!offline) {
    const t0 = Date.now();
    try {
      const conn = new Connection(rpc, "confirmed");
      if (wallet) out.sol = (await conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
      else await conn.getSlot();
      out.connection = `${isPublic ? "public Solana RPC" : "private RPC"}, ${Date.now() - t0} ms`;
    } catch (e) {
      out.connection = `FAILED: ${e.message}`;
    }
  } else out.connection = isPublic ? "public Solana RPC" : "private RPC";

  // Keys
  const src = keySources();
  for (const [name, k] of Object.entries(KEYS)) {
    if (name === "rpc") {
      out.keys.rpc = { set: !!src.rpc, from: src.rpc, status: src.rpc ? (out.connection?.startsWith("FAILED") ? "rejected" : "works") : "not set", need: k.need };
      continue;
    }
    const set = !!src[name];
    out.keys[name] = { set, from: src[name], status: set ? (offline ? "saved" : await verify(name, cfg)) : "not set", need: k.need };
  }
  const ok = (name) => out.keys[name].set && !/rejected/.test(out.keys[name].status);

  // What works / what's blocked, in plain words
  const funded = out.sol === null ? null : out.sol >= MIN_LAUNCH_SOL;
  const canLaunch = !!wallet && funded !== false && ok("pinata");
  if (canLaunch) out.works.push("Launch a coin from any tweet link, post or name (launch_coin / serial-dev launch).");
  else out.blocked.push("Launching: " + [!wallet && "no wallet", funded === false && "wallet has no SOL", !ok("pinata") && "no picture host (Pinata key)"].filter(Boolean).join(", ") + ".");
  out.works.push("Read any tweet and draft the coin (free, no key).");
  out.works.push("Truth Social, news and pump.fun trend feeds (free, no key).");
  out.works.push("Real pictures: from the post, the account's profile, linked pages (free).");
  if (ok("twitterapi")) out.works.push("Watching X accounts live and the viral feed.");
  else out.blocked.push("Watching X accounts live (Elon etc.) and the viral feed: needs a twitterapi.io key.");
  if (ok("fal") || ok("openai")) out.works.push("Drawing pictures with GPT Image when no real one exists.");
  else out.blocked.push("Drawing pictures with GPT Image: needs a fal or OpenAI key (optional, real pictures still work).");

  // Next steps, most important first
  const keyStep = (name) => `Get a ${name} key: ${KEYS[name].get}  Then run: serial-dev keys set ${name}`;
  if (!wallet) out.next.push("Make the dev wallet: serial-dev init");
  else if (funded === false)
    out.next.push(
      cfg.network === "devnet"
        ? `Send devnet SOL to ${out.wallet} (any devnet faucet, or from another devnet wallet). About 1 SOL lets you test plenty.`
        : `Send SOL to ${out.wallet}. Each launch costs ~0.006 SOL plus whatever dev buy you choose.`
    );
  if (!ok("pinata")) out.next.push(out.keys.pinata.set ? "Your Pinata key was rejected. Make a new one with Admin access: serial-dev keys set pinata" : keyStep("pinata"));
  if (!ok("twitterapi")) out.next.push((out.keys.twitterapi.set ? "Your twitterapi.io key was rejected. " : "For autopilot on X: ") + keyStep("twitterapi"));
  if (cfg.network === "mainnet" && !out.keys.rpc.set) out.next.push(`For speed on mainnet: ${keyStep("rpc")}`);
  if (!ok("fal") && !ok("openai")) out.next.push(`Optional, for drawn pictures: ${keyStep("fal")}`);
  if (cfg.network === "devnet" && canLaunch) out.next.push("When you're ready for real SOL, a human runs: serial-dev config network mainnet");
  out.ready = canLaunch;
  out.files = { wallet: fs.existsSync(FILES.wallet) ? FILES.wallet : null, keys: fs.existsSync(FILES.keys) ? FILES.keys : null };
  return out;
}

// Human-readable version for the terminal.
export function formatDoctor(d) {
  const mark = (b) => (b ? "[ok]" : "[--]");
  const lines = [];
  lines.push(`serial-dev setup check (${d.network.toUpperCase()})`);
  lines.push("");
  lines.push(`${mark(!!d.wallet)} wallet       ${d.wallet || "none yet"}`);
  if (d.wallet) lines.push(`${mark(d.sol > 0)} balance      ${d.sol === null ? "unknown" : d.sol + " SOL"}`);
  lines.push(`${mark(!String(d.connection).startsWith("FAILED"))} connection   ${d.connection}`);
  for (const [name, k] of Object.entries(d.keys)) {
    const good = k.set && !/rejected/.test(k.status);
    lines.push(`${mark(good)} ${name.padEnd(12)} ${k.set ? k.status : "not set"}${k.set && k.from ? `  (from ${k.from === "env" ? "env var" : "saved keys"})` : ""}  [${k.need}]`);
  }
  lines.push("");
  lines.push("Works now:");
  for (const w of d.works) lines.push(`  + ${w}`);
  if (d.blocked.length) {
    lines.push("Not yet:");
    for (const b of d.blocked) lines.push(`  - ${b}`);
  }
  if (d.next.length) {
    lines.push("");
    lines.push("Next steps:");
    d.next.forEach((n, i) => lines.push(`  ${i + 1}. ${n}`));
  }
  lines.push("");
  lines.push("Keys are saved in your home folder, never in a project. `serial-dev keys` lists what each one does.");
  return lines.join("\n");
}
