import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";

process.env.SERIAL_DEV_HOME = new URL("../scratch/test-home", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const { decodeCreateEvent, normName } = await import("../src/trend.js");
const { parseRss } = await import("../src/sources.js");
const { tierOf, rulesFor, checkItem } = await import("../src/guards.js");
const { DEFAULTS } = await import("../src/config.js");

const cfg = { ...DEFAULTS, keys: {} };
const post = (text, extra = {}) => ({
  id: String(Math.floor(Math.random() * 1e15)),
  url: "https://x.com/a/status/1",
  text,
  createdAt: Date.now(),
  author: { handle: "someone", followers: 1000 },
  media: [],
  likes: 5,
  isReply: false,
  isRetweet: false,
  quoted: null,
  source: "x",
  ...extra,
});

test("decode a pump.fun launch from its log line", () => {
  const str = (s) => {
    const b = Buffer.from(s);
    const n = Buffer.alloc(4);
    n.writeUInt32LE(b.length);
    return Buffer.concat([n, b]);
  };
  const key = (i) => Buffer.alloc(32, i);
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(1794239852n);
  const buf = Buffer.concat([Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]), str("MARRY OR REFUND"), str("REFUND"), str("https://x/meta.json"), key(1), key(2), key(3), key(4), ts]);
  const ev = decodeCreateEvent(buf.toString("base64"));
  assert.equal(ev.name, "MARRY OR REFUND");
  assert.equal(ev.symbol, "REFUND");
  assert.equal(ev.creator, bs58.encode(key(4)));
  assert.equal(decodeCreateEvent(Buffer.alloc(200).toString("base64")), null);
  assert.equal(normName("Marry or Refund!"), normName("MARRY OR REFUND"));
});

test("rss: Truth Social archive and Google News shapes", () => {
  const truth = `<rss><channel><item><title><![CDATA[Image post from November 8, 2026]]></title><link>https://www.trumpstruth.org/statuses/1</link><description><![CDATA[<p>MAKE AMERICA GREAT</p>]]></description><guid>g1</guid><pubDate>Sun, 08 Nov 2026 23:43:12 +0000</pubDate><truth:originalUrl>https://truthsocial.com/@realDonaldTrump/117</truth:originalUrl><archive:postType>original</archive:postType><media:content url="https://img/1.jpg" medium="image"></media:content></item></channel></rss>`;
  const [t] = parseRss(truth);
  assert.equal(t.description, "MAKE AMERICA GREAT");
  assert.deepEqual(t.images, ["https://img/1.jpg"]);
  assert.equal(t.originalUrl, "https://truthsocial.com/@realDonaldTrump/117");
  const news = `<item><title>UK's Russell Brand sentenced to 10 years - Reuters</title><link>https://n/1</link><guid>n1</guid><pubDate>Mon, 09 Nov 2026 15:28:43 GMT</pubDate></item>`;
  assert.equal(parseRss(news)[0].title, "UK's Russell Brand sentenced to 10 years - Reuters");
});

test("tiers decide what gets coined", () => {
  const c = { ...cfg, watch: { ...cfg.watch, tiers: { ElonMusk: "S" } } };
  const elonText = post("Grok will be superintelligent", { author: { handle: "elonmusk", followers: 1 } });
  assert.equal(tierOf(elonText, c), "S");
  assert.equal(checkItem(elonText, c), null); // S coins text-only posts
  const nobodyText = post("Grok will be superintelligent", { author: { handle: "nobody", followers: 1 } });
  assert.equal(tierOf(nobodyText, c), "A");
  assert.equal(checkItem(nobodyText, c), "no picture in the post");
  assert.equal(rulesFor({ source: "news" }, c).tier, "news");
  assert.equal(rulesFor({ source: "truth" }, c).tier, "S");
  assert.equal(rulesFor({ source: "trend" }, c).tier, "trend");
  // news may be older than a tweet before it's stale
  assert.equal(checkItem(post("Eli Lilly pill", { source: "news", kind: "news", createdAt: Date.now() - 600e3 }), c), null);
});
