// The checks that run before every launch. They keep an autopilot from burning the wallet
// or launching a coin off something nobody should launch a coin off.
import { launches, seen } from "./ledger.js";

// Which tier an item falls in: S (coin everything), A (images only), news, viral, trend.
export function tierOf(item, cfg) {
  if (item.tier) return item.tier;
  const src = item.source;
  if (src && cfg.sources[src]?.tier) return cfg.sources[src].tier;
  const h = String(item.author?.handle || "").toLowerCase();
  const tiers = Object.fromEntries(Object.entries(cfg.watch.tiers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return tiers[h] || "A";
}

export function rulesFor(item, cfg) {
  const tier = tierOf(item, cfg);
  return { tier, ...(cfg.tiers[tier] || cfg.tiers.A) };
}

const hasOwnPicture = (item) => !!(item.media?.length || item.quoted?.media?.length);

export function checkItem(item, cfg, rules = rulesFor(item, cfg)) {
  const f = cfg.filters;
  if (seen(item.id)) return "already handled this post";
  if (item.isRetweet) return "repost";
  if (rules.skipReplies && item.isReply) return "reply";
  if (rules.requireMedia && !hasOwnPicture(item)) return "no picture in the post";
  if (item.source === "x" || item.source === "viral") {
    if ((item.author?.followers || 0) < f.minAuthorFollowers) return `author under ${f.minAuthorFollowers} followers`;
    if ((item.likes || 0) < f.minLikes) return `under ${f.minLikes} likes`;
  }
  const age = (Date.now() - item.createdAt) / 1000;
  const maxAge = rules.maxAgeSeconds ?? f.maxTweetAgeSeconds;
  if (maxAge && age > maxAge) return `post is ${Math.round(age)}s old (max ${maxAge}s for tier ${rules.tier})`;
  const text = (item.text || "").toLowerCase();
  const hit = (f.blockWords || []).find((w) => text.includes(String(w).toLowerCase()));
  if (hit) return `blocked word "${hit}"`;
  return null;
}

// Back-compat name.
export const checkTweet = (tweet, cfg) => checkItem({ source: "x", ...tweet }, cfg);

export function checkLimits(cfg, devBuySol = 0, { burst = false } = {}) {
  const l = cfg.limits;
  const mine = launches(cfg.network);
  const now = Date.now();
  const lastHour = mine.filter((e) => now - Date.parse(e.at) < 3600e3);
  if (l.maxLaunchesPerHour && lastHour.length >= l.maxLaunchesPerHour) return `hit ${l.maxLaunchesPerHour} launches this hour`;
  const last = mine.at(-1);
  if (!burst && l.cooldownSeconds && last && now - Date.parse(last.at) < l.cooldownSeconds * 1000) return "cooling down between launches";
  const spent24h = mine.filter((e) => now - Date.parse(e.at) < 86400e3).reduce((s, e) => s + (Number(e.solSpent) || 0), 0);
  const estimate = Number(devBuySol || 0) + 0.03;
  if (l.maxSolPerDay && spent24h + estimate > l.maxSolPerDay) return `daily budget: ${spent24h.toFixed(3)} of ${l.maxSolPerDay} SOL used`;
  return null;
}
