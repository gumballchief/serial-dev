// Real-time tweet feed for the accounts and keywords you watch.
//
// stream mode (default): twitterapi.io filter rules + one WebSocket. Pay per tweet delivered.
// poll mode: asks for each account's latest tweets on a timer. Simpler, slower, fine for a few accounts.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { fromTwitterApi, getLatestTweets } from "./tweets.js";

const API = process.env.TWITTERAPI_BASE || "https://api.twitterapi.io";
const WS_URL = process.env.TWITTERAPI_WS || "wss://ws.twitterapi.io/twitter/tweet/websocket";
const TAG = "serial-dev";
const STOP_CODES = new Set([4001, 4003, 4009]);

async function api(cfg, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { "x-api-key": cfg.keys.twitterapi, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") throw new Error(`twitterapi.io ${path}: ${j.msg || j.message || r.status}`);
  return j;
}

// Pack "from:a OR from:b OR keyword" into as few 255-char rules as possible.
export function buildRules(accounts = [], keywords = []) {
  const terms = [
    ...accounts.map((a) => `from:${a.replace(/^@/, "").trim()}`),
    ...keywords.map((k) => (/\s/.test(k) ? `"${k}"` : k)),
  ].filter((t) => t && t !== "from:");
  const rules = [];
  let cur = "";
  for (const t of terms) {
    const next = cur ? `${cur} OR ${t}` : t;
    if (next.length > 255) {
      rules.push(cur);
      cur = t;
    } else cur = next;
  }
  if (cur) rules.push(cur);
  return rules;
}

// Make twitterapi.io's rules match our watch list: delete stale serial-dev rules, add + activate new ones.
export async function syncRules(cfg) {
  const wanted = buildRules(cfg.watch.accounts, cfg.watch.keywords);
  const { rules = [] } = await api(cfg, "GET", "/oapi/tweet_filter/get_rules");
  const ours = rules.filter((r) => String(r.tag || "").startsWith(TAG));
  const keep = new Set();
  for (const r of ours) {
    if (wanted.includes(r.value)) keep.add(r.value);
    else await api(cfg, "DELETE", "/oapi/tweet_filter/delete_rule", { rule_id: r.rule_id });
  }
  // Never under 5 s: faster checks make twitterapi.io re-send (and bill) the newest post every check.
  const interval = Math.max(5, Number(cfg.watch.intervalSeconds) || 5);
  for (const [i, value] of wanted.entries()) {
    if (keep.has(value)) continue;
    const tag = `${TAG}-${Date.now()}-${i}`;
    const { rule_id } = await api(cfg, "POST", "/oapi/tweet_filter/add_rule", { tag, value, interval_seconds: interval });
    await api(cfg, "POST", "/oapi/tweet_filter/update_rule", { rule_id, tag, value, interval_seconds: interval, is_effect: 1 });
  }
  return wanted;
}

// Pull tweet objects out of a stream message, whatever envelope it arrives in.
export function tweetsFromMessage(msg) {
  if (!msg || typeof msg !== "object") return [];
  const list = msg.tweets || msg.data?.tweets || (msg.tweet ? [msg.tweet] : null) || (Array.isArray(msg.data) ? msg.data : null) || [];
  return list.map(fromTwitterApi).filter(Boolean);
}

export class Watcher extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.stopped = false;
    this.timer = null;
    this.lastSeen = new Map();
    this.delivered = new Set();
  }

  async start() {
    const { cfg } = this;
    if (!cfg.keys.twitterapi) throw new Error("Watching X needs TWITTERAPI_KEY (twitterapi.io). Without it, feed tweets in yourself: launch_coin / serial-dev launch <tweet link>.");
    if (!cfg.watch.accounts.length && !cfg.watch.keywords.length) throw new Error("Watch list is empty. Add accounts: serial-dev watch add elonmusk");
    if (cfg.watch.mode === "poll") return this.poll();
    const rules = await syncRules(cfg);
    this.emit("status", `watching ${cfg.watch.accounts.length} accounts, ${cfg.watch.keywords.length} keywords (${rules.length} rules)`);
    this.connect(5);
  }

  connect(delay) {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL, { headers: { "x-api-key": this.cfg.keys.twitterapi } });
    this.ws = ws;
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.event_type === "connected") return this.emit("status", "stream connected");
      if (msg.event_type === "ping") return;
      if (msg.event_type === "replaced") return this.emit("status", "another client took over this API key");
      for (const t of tweetsFromMessage(msg)) {
        // The stream can deliver the same post more than once (and a backlog of old ones on connect).
        if (this.delivered.has(t.id)) continue;
        this.delivered.add(t.id);
        if (this.delivered.size > 5000) this.delivered.delete(this.delivered.values().next().value);
        this.emit("tweet", t);
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        let j = {};
        try {
          j = JSON.parse(body);
        } catch {}
        if (STOP_CODES.has(j.error_code)) {
          this.stopped = true;
          this.emit("error", new Error(`stream refused: ${j.message || res.statusCode}`));
        } else {
          const wait = Number(res.headers["retry-after"]) || delay;
          setTimeout(() => this.connect(Math.min(delay * 2, 60)), wait * 1000);
        }
      });
    });
    ws.on("close", (code) => {
      if (this.stopped || this.ws !== ws) return;
      if (STOP_CODES.has(code)) {
        this.stopped = true;
        return this.emit("error", new Error(`stream closed (${code}): another client is using this API key`));
      }
      this.emit("status", `stream dropped (${code}), reconnecting in ${delay}s`);
      setTimeout(() => this.connect(Math.min(delay * 2, 60)), delay * 1000);
    });
    ws.on("error", () => {});
  }

  async poll() {
    const every = Math.max(2, Number(this.cfg.watch.intervalSeconds) || 5) * 1000;
    this.emit("status", `polling ${this.cfg.watch.accounts.length} accounts every ${every / 1000}s`);
    const tick = async () => {
      for (const handle of this.cfg.watch.accounts) {
        try {
          const list = await getLatestTweets(handle, this.cfg);
          const last = this.lastSeen.get(handle);
          if (list[0]) this.lastSeen.set(handle, list[0].id);
          if (!last) continue; // first pass only sets the baseline
          for (const t of list) {
            if (BigInt(t.id) <= BigInt(last)) break;
            this.emit("tweet", t);
          }
        } catch (e) {
          this.emit("status", `poll ${handle}: ${e.message}`);
        }
      }
      if (!this.stopped) this.timer = setTimeout(tick, every);
    };
    tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {}
  }
}
