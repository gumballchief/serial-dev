// Tweet -> coin draft (name, ticker, image, description, links).
// This is the fast heuristic. An LLM agent should look at the draft and write a sharper
// name/ticker when it can: picking the meme is the whole edge.

const STOP = new Set(
  (
    "a an the and or but if then so of to in on at by for with from up down out over under again further once here there " +
    "when where why how all any both each few more most other some such no nor not only own same than too very can will just " +
    "don should now is are was were be been being have has had having do does did doing i me my myself we our ours you your " +
    "he him his she her it its they them their what which who whom this that these those am im it's its i'm you're we're " +
    "let's lets get got gonna wanna just like really today tonight tomorrow yesterday new one two yes yeah lol lmao omg rt via " +
    "about into through during before after above below between off also even still much many every going make made says said " +
    // filler and interjections make terrible tickers
    "hello hi hey wow lmfao wtf bro bruh nah ok okay damn holy shit fuck gm gn ngl tbh fr imo guys everyone people thing things"
  ).split(" ")
);

const NAME_MAX = 32;
// pump.fun accepts at least 13 (seen on chain: "RussellBrand", "LindseyHorvat").
const TICKER_MAX = 13;
const PREFIX = /^(?:breaking|just in|new|update|alert|developing|watch|live|report|exclusive|urgent)\s*(?:news)?\s*[:\-|]\s*/i;
// "a dog called Max", "named Floki", "meet Pnut"
const NAMED = /\b(?:called|named|name is|nicknamed|meet)\s+["“]?([A-Za-z][\w-]{1,20})/i;
const SUBJECT_VERBS = new Set("will is was are has had just can could should would does did may might gets got wants needs says said".split(" "));
const CONNECTORS = new Set(["of", "de", "la", "al", "bin", "von", "van", "the", "and", "&"]);

function isShouting(s) {
  const letters = s.replace(/[^A-Za-z]/g, "");
  return letters.length > 6 && letters === letters.toUpperCase();
}

// First run of 2-4 capitalized words: the person, company or place a headline is about.
function entityOf(text) {
  const tokens = text.split(/\s+/);
  let run = [];
  const flush = () => {
    while (run.length && CONNECTORS.has(run.at(-1).toLowerCase())) run.pop();
    return run.length >= 2 ? run.join(" ") : null;
  };
  for (const tok of tokens) {
    const w = tok.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'’.-]+$/g, "").replace(/[.'’]+$/, "");
    const isCap = /^[A-Z][a-z][\w'’.-]*$/.test(w) || /^[A-Z][A-Za-z]*[A-Z][\w-]*$/.test(w);
    const ok = w && !/^[$#]/.test(tok) && !STOP.has(w.toLowerCase()) && (isCap || (run.length && CONNECTORS.has(w.toLowerCase())));
    if (ok) run.push(w);
    if (!ok || /[,.:;!?)]$/.test(tok)) {
      const e = flush();
      if (e) return e.split(" ").slice(0, 4).join(" ");
      run = [];
    }
  }
  return flush();
}

function analyze(raw) {
  const cleaned = clean(raw).replace(PREFIX, "").trim();
  const shout = isShouting(cleaned);
  const quoted = cleaned.match(/["“]([^"”]{2,32})["”]/)?.[1]?.replace(/[.,!?]+$/, "").trim() || null;
  const named = cleaned.match(NAMED)?.[1] || null;
  // "@grok will be superintelligent": the post is about that account.
  const atSubject = raw.match(/@([A-Za-z0-9_]{2,15})\s+(?:will|is|was|are|has|had|just|can|could|should|would|does|did|may|might|gets|got|wants|needs|says|said|now)\b/i)?.[1] || null;
  const entity = shout ? null : entityOf(cleaned);
  return { cleaned, shout, quoted, named, entity, atSubject };
}

// "Russell Brand" -> RUSSELLBRAND if it fits, else the last word (BRAND).
function tickerFromPhrase(phrase) {
  const joined = tickerOf(phrase);
  if (joined.length && joined.length <= TICKER_MAX) return joined;
  const words = phrase.split(/\s+/).filter((w) => !STOP.has(w.toLowerCase()));
  return tickerOf(words.at(-1) || phrase);
}

function clean(text) {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)@\w+/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(s) {
  return s.replace(/\S+/g, (w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)));
}

function cut(s, max) {
  if (s.length <= max) return s;
  const words = s.split(" ");
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > max) break;
    out = (out + " " + w).trim();
  }
  return out || s.slice(0, max);
}

export function tickerOf(word) {
  return word
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, TICKER_MAX);
}

function pickTicker(raw, a) {
  const cash = raw.match(/\$([A-Za-z][A-Za-z0-9]{1,12})\b/);
  if (cash) return { ticker: cash[1].toUpperCase(), why: "cashtag in post" };
  const tag = raw.match(/#([A-Za-z][A-Za-z0-9_]{1,24})/);
  if (tag) return { ticker: tickerOf(tag[1]), why: "hashtag" };
  if (a.named) return { ticker: tickerOf(a.named), why: "the name in the post" };
  if (a.atSubject) return { ticker: tickerOf(a.atSubject), why: "the account the post is about" };
  if (a.entity) return { ticker: tickerFromPhrase(a.entity), why: "who/what the post is about" };
  if (a.quoted && tickerOf(a.quoted).length <= TICKER_MAX) return { ticker: tickerOf(a.quoted), why: "quoted phrase" };
  const tokens = a.cleaned.split(/\s+/);
  const words = tokens.map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""));
  let best = null;
  words.forEach((w, i) => {
    if (w.length < 2 || STOP.has(w.toLowerCase()) || STOP.has(w.toLowerCase().replace(/(.)\1{2,}/g, "$1"))) return;
    let score = Math.min(w.length, 8);
    const sentenceStart = i === 0 || /[.!?]$/.test(tokens[i - 1]);
    const next = (words[i + 1] || "").toLowerCase();
    if (!a.shout) {
      if (!sentenceStart && /^[A-Z]/.test(w)) score += 6; // proper noun mid-sentence
      if (/^[A-Z0-9]{2,}$/.test(w)) score += 4; // SHOUTED in a normal sentence
      // The subject of the opening sentence: "Grok will be superintelligent", "Doge is back"
      if (i === 0 && /^[A-Z]/.test(w) && SUBJECT_VERBS.has(next)) score += 10;
    }
    if (/(ed|ing|ly|ness|tion)$/i.test(w)) score -= 4; // verbs/adverbs make bad tickers
    if (a.quoted && a.quoted.includes(w)) score += 8;
    if (!best || score > best.score) best = { w, score };
  });
  if (best) return { ticker: tickerOf(best.w), why: "strongest word" };
  return { ticker: "TWEET", why: "fallback" };
}

function pickName(a, ticker) {
  if (a.quoted) return a.quoted;
  if (a.named) return titleCase(a.named.toLowerCase());
  if (a.atSubject) return /[A-Z]/.test(a.atSubject) ? a.atSubject : titleCase(a.atSubject);
  if (a.entity) return a.entity;
  const noTags = a.cleaned.replace(/[#$]/g, "").trim();
  if (noTags && noTags.length <= NAME_MAX) return titleCase(a.shout ? noTags.toLowerCase() : noTags);
  // Long post: name the coin after the ticker word in context.
  const word = noTags.split(/\s+/).find((w) => tickerOf(w) === ticker);
  return word ? titleCase(word.replace(/[^A-Za-z0-9 -]/g, "")) : titleCase(ticker.toLowerCase());
}

export function draftCoin(tweet, cfg, overrides = {}) {
  const raw = tweet.text || "";
  const a = analyze(raw);
  const cleaned = a.cleaned;
  const t = pickTicker(raw, a);
  const ticker = tickerOf(overrides.ticker || t.ticker) || "TWEET";
  const name = cut((overrides.name || pickName(a, ticker) || ticker).trim(), NAME_MAX);
  const photo = tweet.media?.find((m) => m.type === "photo") || tweet.media?.[0];
  const image = overrides.image || photo?.url || tweet.quoted?.media?.[0]?.url || null;
  const handle = tweet.author?.handle;
  const who = handle ? `@${handle}` : tweet.author?.name;
  let description = overrides.description;
  if (!description) {
    const quote = cleaned.length > 180 ? cleaned.slice(0, 177) + "..." : cleaned;
    description = quote ? `"${quote}"${who ? ` - ${who}` : ""}` : `Post by ${who}`;
    const kind = tweet.kind === "news" ? "Headline coin" : tweet.source === "truth" ? "Truth coin" : "Tweet coin";
    if (cfg?.coin?.notAffiliated !== false && who) description += `\n\n${kind}. Not affiliated with ${who}.`;
  }
  return {
    name,
    ticker,
    image,
    description,
    twitter: tweet.url,
    website: cfg?.coin?.website || "",
    telegram: cfg?.coin?.telegram || "",
    tweetId: tweet.id,
    tweetUrl: tweet.url,
    author: handle,
    why: overrides.ticker ? "agent override" : t.why,
    warnings: [
      ...(image ? [] : ["no picture in the post: one gets found or generated at launch (see image_options)"]),
      ...(name.length < 2 ? ["name too short"] : []),
    ],
  };
}
