// Copy what's already trending: watch every pump.fun launch live and catch names that several
// different devs are launching at once. Real serial devs do this (one wallet in our on-chain sample
// only ever relaunched coins other devs were already pushing). Free: uses your Solana RPC, no X key.
import { EventEmitter } from "node:events";
import bs58 from "bs58";
import WebSocket from "ws";
import { rpcFor } from "./config.js";

const MINT_AUTHORITY = "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"; // every pump.fun create touches it
const CREATE_EVENT = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

function readStr(b, o) {
  const n = b.readUInt32LE(o);
  return [b.subarray(o + 4, o + 4 + n).toString("utf8"), o + 4 + n];
}

// Decode pump.fun's CreateEvent from a "Program data:" log line.
export function decodeCreateEvent(base64) {
  const b = Buffer.from(base64, "base64");
  if (b.length < 8 + 12 + 128 || !b.subarray(0, 8).equals(CREATE_EVENT)) return null;
  try {
    let o = 8;
    let name, symbol, uri;
    [name, o] = readStr(b, o);
    [symbol, o] = readStr(b, o);
    [uri, o] = readStr(b, o);
    const key = () => {
      const k = bs58.encode(b.subarray(o, o + 32));
      o += 32;
      return k;
    };
    const mint = key();
    const bondingCurve = key();
    const user = key();
    const creator = key();
    const timestamp = Number(b.readBigInt64LE(o));
    return { name, symbol, uri, mint, bondingCurve, user, creator, timestamp };
  } catch {
    return null;
  }
}

export const normName = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

export class TrendWatcher extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.window = new Map(); // normName -> [{ creator, at, ev }]
    this.fired = new Set();
    this.stopped = false;
  }

  start() {
    const http = rpcFor(this.cfg);
    const url = this.cfg.sources.trend.wsUrl || http.replace(/^http/, "ws");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [MINT_AUTHORITY] }, { commitment: "confirmed" }] }));
      this.emit("status", "watching every pump.fun launch");
      this.ping = setInterval(() => ws.readyState === 1 && ws.ping(), 20000);
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const logs = msg.params?.result?.value?.logs;
      if (!logs || msg.params.result.value.err) return;
      for (const line of logs) {
        if (!line.startsWith("Program data: ")) continue;
        const ev = decodeCreateEvent(line.slice(14));
        if (ev) this.onCreate(ev);
      }
    });
    ws.on("close", () => {
      clearInterval(this.ping);
      if (!this.stopped) setTimeout(() => this.start(), 3000);
    });
    ws.on("error", (e) => this.emit("status", `launch feed: ${e.message}`));
  }

  onCreate(ev) {
    this.emit("create", ev);
    const t = this.cfg.sources.trend;
    const key = normName(ev.name);
    if (key.length < 2 || this.fired.has(key)) return;
    const now = Date.now();
    const list = (this.window.get(key) || []).filter((x) => now - x.at < t.windowMinutes * 60e3);
    list.push({ creator: ev.creator, at: now, ev });
    this.window.set(key, list);
    const devs = new Set(list.map((x) => x.creator)).size;
    if (devs >= t.minDevs) {
      this.fired.add(key);
      this.emit("trend", { name: ev.name, symbol: ev.symbol, devs, launches: list.length, examples: list.slice(-3).map((x) => x.ev) });
    }
    // keep memory small
    if (this.window.size > 5000) for (const [k, v] of this.window) if (now - v.at(-1).at > t.windowMinutes * 60e3) this.window.delete(k);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
  }
}

// Turn a trend into a launchable item, borrowing the source post + picture from one of the copies.
export async function trendToItem(trend) {
  let meta = {};
  for (const ex of trend.examples.slice().reverse()) {
    try {
      meta = await (await fetch(ex.uri, { signal: AbortSignal.timeout(4000) })).json();
      if (meta?.image) break;
    } catch {}
  }
  const link = [meta.twitter, meta.website].find((u) => /(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(u || "")) || "";
  return {
    id: `trend:${normName(trend.name)}:${Math.floor(Date.now() / 600e3)}`,
    url: link,
    text: trend.name,
    createdAt: Date.now(),
    author: { handle: (link.match(/\.com\/@?([^/]+)\/status/) || [])[1] || "", name: "", followers: 0, avatar: "" },
    media: meta.image ? [{ type: "photo", url: meta.image }] : [],
    likes: 0,
    isReply: false,
    isRetweet: false,
    quoted: null,
    links: link ? [link] : [],
    source: "trend",
    kind: "post",
    trend: { devs: trend.devs, launches: trend.launches, symbol: trend.symbol },
    suggested: { name: trend.name.slice(0, 32), ticker: trend.symbol },
  };
}
