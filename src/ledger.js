import fs from "node:fs";
import { FILES, ensureHome } from "./config.js";

// Append-only log of everything the dev did. Powers stats, rate limits and fee sweeps.
export function record(entry) {
  ensureHome();
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFileSync(FILES.ledger, line + "\n");
}

export function readLedger() {
  try {
    return fs
      .readFileSync(FILES.ledger, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function launches(network) {
  return readLedger().filter((e) => e.type === "launch" && (!network || e.network === network));
}

// Tweets we've already handled, so a reconnect or a duplicate event never double-launches.
let seenCache;
export function seen(id) {
  if (!seenCache) {
    try {
      seenCache = new Set(JSON.parse(fs.readFileSync(FILES.seen, "utf8")));
    } catch {
      seenCache = new Set();
    }
  }
  return seenCache.has(String(id));
}

export function markSeen(id) {
  seen(id);
  seenCache.add(String(id));
  ensureHome();
  const all = [...seenCache].slice(-5000);
  fs.writeFileSync(FILES.seen, JSON.stringify(all));
}

export function summarize(network) {
  const all = readLedger().filter((e) => !network || e.network === network);
  const now = Date.now();
  const hour = now - 3600e3;
  const day = now - 86400e3;
  const ls = all.filter((e) => e.type === "launch");
  const sum = (arr, k) => arr.reduce((s, e) => s + (Number(e[k]) || 0), 0);
  const sells = all.filter((e) => e.type === "sell");
  const claims = all.filter((e) => e.type === "claim");
  const spent = sum(ls, "solSpent");
  const sold = sum(sells, "solReceived");
  const claimed = sum(claims, "solClaimed");
  return {
    network: network || "all",
    launches: ls.length,
    launchesLastHour: ls.filter((e) => Date.parse(e.at) > hour).length,
    launchesLast24h: ls.filter((e) => Date.parse(e.at) > day).length,
    solSpentLast24h: +sum(ls.filter((e) => Date.parse(e.at) > day), "solSpent").toFixed(6),
    solSpentOnLaunches: +spent.toFixed(6),
    solFromSells: +sold.toFixed(6),
    solFeesClaimed: +claimed.toFixed(6),
    netSol: +(sold + claimed - spent).toFixed(6),
    lastLaunch: ls.at(-1) ? '$' + ls.at(-1).ticker + ' "' + ls.at(-1).name + '" ' + ls.at(-1).mint + ' at ' + ls.at(-1).at : null,
  };
}
