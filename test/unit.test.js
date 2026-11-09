import { test } from "node:test";
import assert from "node:assert/strict";
process.env.SERIAL_DEV_HOME = new URL("../scratch/test-home", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const { draftCoin, tickerOf } = await import("../src/draft.js");
const { buildRules, tweetsFromMessage } = await import("../src/watch.js");
const { parseTweetId, fromFx, fromTwitterApi } = await import("../src/tweets.js");
const { checkTweet } = await import("../src/guards.js");
const { DEFAULTS } = await import("../src/config.js");

const cfg = { ...DEFAULTS, keys: {} };
const tw = (text, extra = {}) => ({
  id: String(Math.floor(Math.random() * 1e15)), url: "https://x.com/a/status/1", text, createdAt: Date.now(),
  author: { handle: "someone", followers: 1000 }, media: [{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }],
  likes: 5, isReply: false, isRetweet: false, quoted: null, ...extra,
});

test("cashtag wins", () => {
  assert.equal(draftCoin(tw("just bought more $WIF lol"), cfg).ticker, "WIF");
});
test("short tweet becomes the name", () => {
  const d = draftCoin(tw("the bird is freed"), cfg);
  assert.equal(d.name, "The Bird Is Freed");
  assert.equal(d.ticker, "BIRD");
});
test("proper noun beats filler in a long tweet", () => {
  const d = draftCoin(tw("Next I'm buying Coca-Cola to put the cocaine back in"), cfg);
  assert.equal(d.ticker, "COCACOLA");
  assert.equal(d.name, "Coca-Cola");
});
test("agent overrides stick", () => {
  const d = draftCoin(tw("Next I'm buying Coca-Cola to put the cocaine back in"), cfg, { ticker: "coke!" });
  assert.equal(d.ticker, "COKE");
  assert.equal(d.name, "Coke");
});
test("limits: ticker 13, name 32", () => {
  const d = draftCoin(tw("Supercalifragilisticexpialidocious"), cfg);
  assert.ok(d.ticker.length <= 13);
  assert.ok(d.name.length <= 32);
  assert.equal(tickerOf("héllo wörld!!"), "HELLOWORLD");
});
test("not-affiliated line + tweet link", () => {
  const d = draftCoin(tw("gm"), cfg);
  assert.match(d.description, /Not affiliated with @someone/);
  assert.equal(d.twitter, "https://x.com/a/status/1");
  assert.equal(d.image, "https://pbs.twimg.com/media/x.jpg");
});
test("tweet ids from links", () => {
  assert.equal(parseTweetId("https://x.com/elonmusk/status/1585841080431321088?s=20"), "1585841080431321088");
  assert.equal(parseTweetId("https://twitter.com/i/web/status/123456789"), "123456789");
  assert.equal(parseTweetId("123456789"), "123456789");
  assert.throws(() => parseTweetId("hello"));
});
test("rules pack under 255 chars", () => {
  const accounts = Array.from({ length: 40 }, (_, i) => `account_number_${i}`);
  const rules = buildRules(accounts, ["dog wif hat"]);
  assert.ok(rules.length > 1);
  for (const r of rules) assert.ok(r.length <= 255);
  assert.ok(rules.join(" OR ").includes('"dog wif hat"'));
  assert.equal(rules.join(" OR ").split(" OR ").length, 41);
});
test("stream messages in any envelope", () => {
  const raw = { id: "9", text: "hi", author: { userName: "bob", followers: 3 }, extendedEntities: { media: [{ type: "photo", media_url_https: "https://img/1.jpg" }] }, createdAt: "Tue Dec 10 07:00:30 +0000 2024" };
  for (const msg of [{ event_type: "tweet", tweets: [raw] }, { data: { tweets: [raw] } }, { tweet: raw }]) {
    const [t] = tweetsFromMessage(msg);
    assert.equal(t.author.handle, "bob");
    assert.equal(t.media[0].url, "https://img/1.jpg");
  }
  assert.deepEqual(tweetsFromMessage({ event_type: "ping" }), []);
});
test("fxtwitter shape", () => {
  const t = fromFx({ id: "1", text: "x", created_timestamp: 1666928951, author: { screen_name: "e", followers: 9 }, media: { photos: [{ url: "https://p/1.jpg" }] } });
  assert.equal(t.createdAt, 1666928951000);
  assert.equal(t.media[0].url, "https://p/1.jpg");
});
test("filters", () => {
  assert.equal(checkTweet(tw("RIP to a legend"), cfg), 'blocked word "rip"');
  assert.equal(checkTweet(tw("hello", { media: [] }), cfg), "no picture in the post");
  assert.equal(checkTweet(tw("hello", { isReply: true }), cfg), "reply");
  assert.match(checkTweet(tw("hello", { createdAt: Date.now() - 600e3 }), cfg), /old/);
  assert.equal(checkTweet(tw("hello"), cfg), null);
});

// Cases taken from real serial-dev launches (Nov 9 2026 on-chain sample).
test("news: the person in the headline", () => {
  const d = draftCoin(tw("BREAKING: Russell Brand sentenced to 10 and a half years in prison"), cfg);
  assert.equal(d.name, "Russell Brand");
  assert.equal(d.ticker, "RUSSELLBRAND");
});
test("news: a quoted phrase wins the name", () => {
  const d = draftCoin(tw("Iran has dismissed a new U.S. task force, saying the effort will “end in failure.” Task Force Iron Gate will target weapons"), cfg);
  assert.equal(d.name, "end in failure");
});
test("all-caps post: the name it mentions", () => {
  const d = draftCoin(tw("HE HAS A DOG CALLED MAX??"), cfg);
  assert.equal(d.ticker, "MAX");
  assert.equal(d.name, "Max");
});
test("company + cashtag", () => {
  const d = draftCoin(tw("Eli Lilly $LLY said its new obesity pill, Foundayo, significantly reduced sleep apnea"), cfg);
  assert.equal(d.name, "Eli Lilly");
  assert.equal(d.ticker, "LLY");
});
test("filler words never become the ticker", () => {
  assert.notEqual(draftCoin(tw("Solana just talked about edging crypto with housing? HELLO"), cfg).ticker, "HELLO");
});
test("the subject of the opening sentence", () => {
  assert.equal(draftCoin(tw("Grok will be superintelligent. Smarter than all humans combined, probably by next year."), cfg).ticker, "GROK");
});

test("a post about an account is named after it", () => {
  const d = draftCoin(tw("@grok will be superintelligent by next year"), cfg);
  assert.equal(d.ticker, "GROK");
  assert.equal(d.name, "Grok");
});
