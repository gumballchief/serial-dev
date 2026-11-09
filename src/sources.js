// Every place a coin idea can come from, as one stream of "items" (same shape as a tweet).
//
//   x       accounts you watch on X (twitterapi.io stream)            -> watch.js
//   truth   Trump's Truth Social posts (public trumpstruth.org feed)
//   news    headline RSS feeds (Google News by default)
//   viral   X posts blowing up right now (twitterapi.io search: min likes, images, last few minutes)
import { EventEmitter } from "node:events";
import { fromTwitterApi } from "./tweets.js";
import { Watcher } from "./watch.js";

const UA = "serial-dev";

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
}

function decode(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRss(xml) {
  return xml
    .split(/<item>/)
    .slice(1)
    .map((chunk) => {
      const item = chunk.split("</item>")[0];
      const images = [...item.matchAll(/<media:content[^>]*url="([^"]+)"[^>]*medium="image"/g)].map((m) => m[1]);
      const enclosure = item.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/);
      return {
        title: decode(tag(item, "title")),
        link: tag(item, "link"),
        guid: tag(item, "guid") || tag(item, "link"),
        description: decode(tag(item, "description")),
        pubDate: tag(item, "pubDate"),
        creator: decode(tag(item, "dc:creator")),
        originalUrl: tag(item, "truth:originalUrl"),
        postType: tag(item, "archive:postType"),
        images: enclosure ? [enclosure[1], ...images] : images,
      };
    });
}

async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

// Truth Social, via the public trumpstruth.org archive (truthsocial.com itself blocks bots).
export async function fetchTruth() {
  const items = parseRss(await getText("https://www.trumpstruth.org/feed"));
  return items
    .filter((i) => i.postType !== "retruth")
    .map((i) => {
      const text = /^(Image|Video) post from/.test(i.title) ? i.description.replace(/View image|View video/g, "").trim() : i.description || i.title;
      return {
        id: `truth:${(i.originalUrl.match(/(\d+)$/) || [])[1] || i.guid}`,
        url: i.originalUrl || i.link,
        text,
        createdAt: Date.parse(i.pubDate) || Date.now(),
        author: { handle: "realDonaldTrump", name: "Donald J. Trump", followers: 10_000_000, avatar: "", verified: true },
        media: i.images.map((url) => ({ type: "photo", url })),
        likes: 0,
        retweets: 0,
        views: 0,
        isReply: false,
        isRetweet: false,
        quoted: null,
        source: "truth",
        kind: "post",
      };
    });
}

// Headlines. Google News titles end in " - Publisher".
export async function fetchNews(feedUrl) {
  const items = parseRss(await getText(feedUrl));
  return items.map((i) => {
    const m = i.title.match(/^(.*) - ([^-]{2,40})$/);
    const headline = m ? m[1] : i.title;
    const publisher = m ? m[2] : new URL(feedUrl).hostname.replace(/^www\./, "");
    return {
      id: `news:${i.guid}`.slice(0, 200),
      url: i.link,
      text: headline,
      createdAt: Date.parse(i.pubDate) || Date.now(),
      author: { handle: "", name: publisher, followers: 0, avatar: "", verified: false },
      media: i.images.map((url) => ({ type: "photo", url })),
      likes: 0,
      retweets: 0,
      views: 0,
      isReply: false,
      isRetweet: false,
      quoted: null,
      source: "news",
      kind: "news",
    };
  });
}

// Posts going viral right now, from anyone (twitterapi.io advanced search).
export async function fetchViral(cfg) {
  const v = cfg.sources.viral;
  const since = Math.floor(Date.now() / 1000) - (v.windowMinutes || 15) * 60;
  const q = `${v.query || ""} min_faves:${v.minLikes || 2000} filter:images -filter:replies -filter:retweets since_time:${since}`.trim();
  const u = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search");
  u.searchParams.set("query", q);
  u.searchParams.set("queryType", "Top");
  const r = await fetch(u, { headers: { "x-api-key": cfg.keys.twitterapi } });
  const j = await r.json().catch(() => ({}));
  if (j.status === "error") throw new Error(j.msg || "twitterapi.io search error");
  return (j.tweets || []).map(fromTwitterApi).filter(Boolean).map((t) => ({ ...t, source: "viral", kind: "post" }));
}

// Likes per minute since posted: how fast something is blowing up.
export function velocity(item) {
  const minutes = Math.max(1, (Date.now() - item.createdAt) / 60000);
  return Math.round((item.likes || 0) / minutes);
}

// One emitter for all enabled sources. Polled sources only emit items newer than when the feed started.
export class Feed extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.timers = [];
    this.seen = new Set();
    this.watcher = null;
    this.startedAt = Date.now();
  }

  emitNew(item, baseline) {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    if (baseline) return; // first poll: remember what's already out there, launch nothing
    this.emit("item", item);
  }

  poll(name, everySeconds, fn) {
    let first = true;
    const tick = async () => {
      try {
        const items = await fn();
        for (const it of items.sort((a, b) => a.createdAt - b.createdAt)) this.emitNew(it, first);
        if (first) this.emit("status", `${name}: watching (${items.length} existing items ignored)`);
        first = false;
      } catch (e) {
        this.emit("status", `${name}: ${e.message}`);
      }
      this.timers.push(setTimeout(tick, everySeconds * 1000));
    };
    tick();
  }

  async start() {
    const { cfg } = this;
    const s = cfg.sources;
    const started = [];
    if (s.x.enabled && (cfg.watch.accounts.length || cfg.watch.keywords.length)) {
      if (!cfg.keys.twitterapi) this.emit("status", "x: skipped, TWITTERAPI_KEY not set");
      else {
        this.watcher = new Watcher(cfg);
        this.watcher.on("tweet", (t) => this.emitNew({ ...t, source: "x", kind: "post" }));
        this.watcher.on("status", (m) => this.emit("status", `x: ${m}`));
        this.watcher.on("error", (e) => this.emit("status", `x: ${e.message}`));
        await this.watcher.start();
        started.push("x");
      }
    }
    if (s.truth.enabled) {
      this.poll("truth", s.truth.pollSeconds, fetchTruth);
      started.push("truth");
    }
    if (s.news.enabled) {
      for (const feed of s.news.feeds) this.poll(`news ${new URL(feed).hostname}`, s.news.pollSeconds, () => fetchNews(feed));
      started.push("news");
    }
    if (s.viral.enabled) {
      if (!cfg.keys.twitterapi) this.emit("status", "viral: skipped, TWITTERAPI_KEY not set");
      else {
        this.poll("viral", s.viral.pollSeconds, () => fetchViral(cfg));
        started.push("viral");
      }
    }
    if (!started.length) throw new Error("No sources running. Add X accounts (needs TWITTERAPI_KEY) or turn on truth/news: serial-dev sources");
    this.emit("status", `sources on: ${started.join(", ")}`);
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.watcher?.stop();
  }
}
