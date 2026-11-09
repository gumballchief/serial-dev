// Usage: TRADER=<any funded mainnet wallet> npm run test:autopilot   (fake tweet stream, launches simulated on mainnet)
// End-to-end autopilot: fake twitterapi.io (rules API + WebSocket) -> filters -> drafts -> launch simulated on MAINNET.
import http from "node:http";
import { WebSocketServer } from "ws";
import { PublicKey } from "@solana/web3.js";
// Point the kit at the fake twitterapi.io below (read when src/watch.js is first imported).
process.env.TWITTERAPI_BASE = "http://127.0.0.1:18181";
process.env.TWITTERAPI_WS = "ws://127.0.0.1:18182";
// Throwaway home, so "already handled" history from real runs (or earlier test runs) never skips a post.
const os = await import("node:os");
const fsMod = await import("node:fs");
process.env.SERIAL_DEV_HOME = fsMod.mkdtempSync((await import("node:path")).join(os.tmpdir(), "serial-dev-autopilot-"));
if (!process.env.TRADER) throw new Error("Set TRADER to any mainnet address holding SOL (simulation only, nothing is spent).");
const rulesCalls = [];
const api = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    rulesCalls.push(`${req.method} ${req.url} ${body}`);
    res.setHeader("content-type", "application/json");
    if (req.url.includes("get_rules")) return res.end(JSON.stringify({ status: "success", rules: [{ rule_id: "old", tag: "serial-dev-stale", value: "from:nobody" }] }));
    if (req.url.includes("add_rule")) return res.end(JSON.stringify({ status: "success", rule_id: "r1", msg: "" }));
    res.end(JSON.stringify({ status: "success", msg: "" }));
  });
}).listen(18181);
const wss = new WebSocketServer({ port: 18182 });
const now = () => new Date().toUTCString().replace("GMT", "+0000");
const t = (id, text, extra = {}) => ({ id, text, url: `https://x.com/elonmusk/status/${id}`, createdAt: now(), likeCount: 10, author: { userName: "elonmusk", followers: 2e8 }, extendedEntities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/test.jpg" }] }, ...extra });
wss.on("connection", (ws, req) => {
  console.log("ws connected with key header:", req.headers["x-api-key"]);
  ws.send(JSON.stringify({ event_type: "connected" }));
  setTimeout(() => ws.send(JSON.stringify({ event_type: "tweet", rule_id: "r1", tweets: [t("900001", "my new dog is named Floki Jr")] })), 300);
  // The real stream can re-send a post. The repeat must be ignored (counts below stay the same).
  setTimeout(() => ws.send(JSON.stringify({ event_type: "tweet", rule_id: "r1", tweets: [t("900001", "my new dog is named Floki Jr")] })), 450);
  setTimeout(() => ws.send(JSON.stringify({ event_type: "tweet", tweets: [t("900002", "RIP to a true legend")] })), 600);
  setTimeout(() => ws.send(JSON.stringify({ event_type: "tweet", tweets: [t("900003", "lol yes", { isReply: true })] })), 900);
  setTimeout(() => ws.send(JSON.stringify({ event_type: "tweet", tweets: [t("900001", "my new dog is named Floki Jr")] })), 1200);
  setTimeout(() => ws.send(JSON.stringify({ event_type: "ping" })), 1300);
  // Tier S: Elon text-only post. Must launch anyway (picture made for it), twice (burst copies).
  setTimeout(() => ws.send(JSON.stringify({ event_type: "tweet", tweets: [t("900004", "Grok will be superintelligent", { extendedEntities: { media: [] } })] })), 1500);
});
const { loadConfig } = await import("../src/config.js");
const engine = await import("../src/engine.js");
const cfg = { ...loadConfig(), network: "mainnet", dryRun: true };
cfg.keys.twitterapi = "test-key";
cfg.watch = { ...cfg.watch, accounts: ["elonmusk"], tiers: { elonmusk: "S" } };
cfg.tiers = { ...cfg.tiers, S: { ...cfg.tiers.S, copies: 2, skipReplies: true } };
cfg.limits = { ...cfg.limits, cooldownSeconds: 0 };
const wallet = { publicKey: new PublicKey(process.env.TRADER) };
const log = [];
const pilot = engine.autopilot(cfg, wallet, { log: (m) => { log.push(m); console.log("  [pilot]", m); } });
await pilot.start();
await new Promise((r) => setTimeout(r, 15000));
pilot.stop(); wss.close(); api.close();
console.log("\nrules API calls:\n " + rulesCalls.join("\n "));
const launched = log.filter((l) => l.startsWith("DRY RUN"));
const skips = log.filter((l) => l.startsWith("skip"));
console.log(`\nRESULT: ${launched.length} simulated launch(es), ${skips.length} skips`);
// Elon is tier S with 2 copies: FLOKI x2 + GROK x2 (text-only, still launched). RIP + reply skipped; the duplicate never reaches the queue.
const ok = launched.filter((l) => l.includes("$FLOKI")).length === 2 && launched.filter((l) => l.includes("$GROK")).length === 2 && skips.length === 2;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
