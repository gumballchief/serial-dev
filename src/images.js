// Picking the coin picture. Measured on 678 real launches (PLAYBOOK.md section 7): the picture IS the
// name. Devs use the real picture of the subject as it is (the post's, its link's, the one other devs
// already used) and only generate when nothing real exists, and then they draw the name itself,
// literally or as a pun. The pick order lives in chooseImage below.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { renderCard } from "./card.js";
import { HOME, ensureHome } from "./config.js";
import { getTweet } from "./tweets.js";

const UA = "serial-dev (open-source memecoin launch kit)";
const withTimeout = (ms) => AbortSignal.timeout(ms);

// The preview picture a page shows when you share it (og:image / twitter:image).
export async function ogImage(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: withTimeout(4000) });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) return null;
    const html = (await r.text()).slice(0, 400_000);
    const m =
      html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    return m ? new URL(m[1].replace(/&amp;/g, "&"), r.url).toString() : null;
  } catch {
    return null;
  }
}

// Lead picture of the best Wikipedia match. Free, no key. Good for names in the news.
export async function wikiImage(query) {
  try {
    const u = new URL("https://en.wikipedia.org/w/api.php");
    Object.entries({ action: "query", generator: "search", gsrsearch: query, gsrlimit: "1", prop: "pageimages", piprop: "thumbnail", pithumbsize: "1000", format: "json" }).forEach(([k, v]) => u.searchParams.set(k, v));
    const j = await (await fetch(u, { headers: { "User-Agent": UA }, signal: withTimeout(4000) })).json();
    const page = Object.values(j.query?.pages || {})[0];
    return page?.thumbnail?.source ? { url: page.thumbnail.source, title: page.title } : null;
  } catch {
    return null;
  }
}

// Image search (needs BRAVE_API_KEY, free tier at api.search.brave.com).
export async function searchImages(query, cfg, count = 4) {
  if (!cfg.keys.brave) return [];
  try {
    const u = new URL("https://api.search.brave.com/res/v1/images/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(count));
    u.searchParams.set("safesearch", "strict");
    const j = await (await fetch(u, { headers: { "X-Subscription-Token": cfg.keys.brave, Accept: "application/json" }, signal: withTimeout(5000) })).json();
    return (j.results || []).map((x) => x.properties?.url || x.thumbnail?.src).filter(Boolean).slice(0, count);
  } catch {
    return [];
  }
}

// Two rules for every coin picture:
// 1. RELEVANCE: the picture IS the name. $CREATINE shows creatine, $GROK shows Grok, $MAX shows the dog
//    called Max. Someone who reads the ticker must see it in the picture at a glance. No invented
//    characters or scenes the name doesn't mention (a dog for $CREATINE is wrong even if it's funny).
// 2. REAL: if a real picture of the subject exists (the post's, a linked page's, image search), use it
//    as it is. Generating is the fallback, and then it must look like a real photo, not AI art.
const PHOTO = [
  "Real photo look: a clean product shot or a candid photograph, natural light, real textures. Not an illustration, not a cartoon, not a 3D render, no glossy CGI look, no neon glow.",
  "One clear subject, centered and filling most of the square frame, on a simple uncluttered background, so it still reads as a tiny circle thumbnail.",
  "No text, captions, letters or watermarks anywhere.",
].join(" ");

const postText = (item) => String(item.text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 400);

// Brief for when nothing real exists: draw the NAME, literally or as a visual pun, the way serial devs do.
// Real examples from the chain: MAGAZINE = a red MAGA hat on a gun magazine; IMPEACH = a man in a suit
// standing on a giant peach; HIGHCAP = a capybara wearing a cap, smoking; CREATINU = a muscular shiba inu
// holding a creatine scoop; HOUSECOIN = a house. "inu" means a shiba, "cap" invites a capybara in a cap.
export function imagePrompt(item, draft) {
  const what = item.kind === "news" ? "headline" : "post";
  return [
    `Square picture for a memecoin called "${draft.name}" (ticker ${draft.ticker}).`,
    `Show the name itself as a picture: either literally what the words are, or a visual pun on them, so anyone who reads "${draft.name}" gets it in one glance.`,
    `Examples of the idea: MAGAZINE is a red MAGA hat sitting on a gun magazine; IMPEACH is a man in a suit standing on a giant peach; HIGHCAP is a capybara wearing a cap; CREATINU is a muscular shiba inu holding a creatine scoop. "inu" means a shiba inu.`,
    `For context only, the ${what} it came from: "${postText(item)}". Don't add anything the name doesn't call for.`,
    PHOTO,
    `Don't show any real person's face.`,
  ].join(" ");
}

export function generatorFor(cfg) {
  const p = cfg.image?.provider || "auto";
  if ((p === "auto" || p === "fal") && cfg.keys.fal) return "fal";
  if ((p === "auto" || p === "openai") && cfg.keys.openai) return "openai";
  if (p === "gemini" && cfg.keys.gemini) return "gemini";
  return null;
}

// The edit brief when we have the subject's real picture: keep it recognizable, put it in a real photo acting out the post.
export function editPrompt(item, draft) {
  const what = item.kind === "news" ? "headline" : "post";
  return [
    `The reference picture shows ${draft.name}. Make a new square picture for a memecoin called "${draft.name}" (ticker ${draft.ticker}).`,
    `${draft.name} from the reference stays the whole point of the picture: the same shape, colors and markings, instantly recognizable, centered and big.`,
    `You may change only the setting or pose to match this ${what}: "${postText(item)}". Don't add characters, animals, people or props the name and the ${what} don't mention.`,
    PHOTO,
    `If the reference shows a real person, don't change their face or put them in a new scene; show the thing from the ${what} instead.`,
  ].join(" ");
}

async function asPng(buf) {
  return sharp(buf).resize(1024, 1024, { fit: "cover" }).png().toBuffer();
}

// Generate a picture. With `reference` (a buffer of the subject's real picture) it edits that
// picture instead of inventing one, which keeps the subject recognizable. Returns a PNG buffer.
export async function generateImage(prompt, cfg, { reference } = {}) {
  const provider = generatorFor(cfg);
  if (!provider) throw new Error("No image generator. Set FAL_KEY or OPENAI_API_KEY (ChatGPT's GPT Image model): serial-dev keys set fal");
  const ref = reference ? await asPng(reference) : null;
  if (provider === "fal") {
    const id = `${cfg.image.falModel}/${ref ? "edit" : "text-to-image"}`;
    const body = { prompt, image_size: "square_hd", quality: cfg.image.quality || "high", output_format: "png" };
    if (ref) body.image_urls = [`data:image/png;base64,${ref.toString("base64")}`];
    const r = await fetch(`${process.env.FAL_BASE_URL || "https://fal.run"}/${id}`, {
      method: "POST",
      headers: { Authorization: `Key ${cfg.keys.fal}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: withTimeout(180_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GPT Image (fal): ${j.detail ? JSON.stringify(j.detail).slice(0, 200) : r.status}`);
    const url = j.images?.[0]?.url;
    if (!url) throw new Error("GPT Image (fal): no picture in the result");
    return url.startsWith("data:") ? Buffer.from(url.split(",")[1], "base64") : Buffer.from(await (await fetch(url)).arrayBuffer());
  }
  if (provider === "openai") {
    const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    let r;
    if (ref) {
      const fd = new FormData();
      fd.append("model", cfg.image.openaiModel);
      fd.append("prompt", prompt);
      fd.append("size", "1024x1024");
      fd.append("quality", cfg.image.quality || "high");
      fd.append("image", new Blob([ref], { type: "image/png" }), "subject.png");
      r = await fetch(`${base}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${cfg.keys.openai}` }, body: fd, signal: withTimeout(120_000) });
    } else {
      r = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.keys.openai}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.image.openaiModel, prompt, size: "1024x1024", quality: cfg.image.quality || "high", n: 1 }),
        signal: withTimeout(90_000),
      });
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`OpenAI image: ${j.error?.message || r.status}`);
    const d = j.data?.[0] || {};
    if (d.b64_json) return Buffer.from(d.b64_json, "base64");
    if (d.url) return Buffer.from(await (await fetch(d.url)).arrayBuffer());
    throw new Error("OpenAI image: empty response");
  }
  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
  let why = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${base}/models/${cfg.image.geminiModel}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": cfg.keys.gemini, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              ...(ref ? [{ inlineData: { mimeType: "image/png", data: ref.toString("base64") } }] : []),
              { text: prompt + (attempt ? " Return only the image." : "") },
            ],
          },
        ],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
      }),
      signal: withTimeout(90_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gemini image: ${j.error?.message || r.status}`);
    const cand = j.candidates?.[0];
    const part = (cand?.content?.parts || []).find((p) => p.inlineData?.data);
    if (part) return Buffer.from(part.inlineData.data, "base64");
    why = [cand?.finishReason, j.promptFeedback?.blockReason, (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join(" ").slice(0, 160)].filter(Boolean).join(": ");
  }
  throw new Error(`Gemini image: no picture returned (${why || "no reason given"})`);
}

export function saveImage(buf, ext = "png") {
  ensureHome();
  const dir = path.join(HOME, "images");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

const isXStatus = (u) => /(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(u);
const mediaOf = (t) => (t?.media || []).map((m) => m.url).filter(Boolean);

// Every free picture option for a post, best first. No generation here (that costs money/time).
export async function imageCandidates(item, draft, cfg, { deep = true, search = true } = {}) {
  const out = [];
  const add = (how, url, note) => url && !out.some((c) => c.url === url) && out.push({ how, url, ...(note ? { note } : {}) });
  mediaOf(item).forEach((u) => add("post", u));
  mediaOf(item.quoted).forEach((u) => add("quoted post", u));
  if (!deep) return out;
  const jobs = [];
  for (const h of accountsIn(item)) jobs.push(profilePicture(h).then((a) => a && add("mentioned account", a.url, `@${a.handle} (${a.name})`)));
  if (item.replyToId && item.source !== "news") {
    jobs.push(getTweet(item.replyToId, cfg).then((p) => mediaOf(p).forEach((u) => add("replied-to post", u, p.text?.slice(0, 80)))).catch(() => {}));
  }
  for (const link of (item.links || []).slice(0, 3)) {
    if (isXStatus(link)) jobs.push(getTweet(link, cfg).then((p) => mediaOf(p).forEach((u) => add("linked post", u))).catch(() => {}));
    else jobs.push(ogImage(link).then((u) => add("linked page", u, link)));
  }
  if (item.kind === "news" && item.url && !/news\.google\.com/.test(item.url)) jobs.push(ogImage(item.url).then((u) => add("article", u)));
  if (search && cfg.image?.search !== false && draft?.name) {
    jobs.push(wikiImage(draft.name).then((w) => w && add("wikipedia", w.url, w.title)));
    jobs.push(searchImages(draft.name, cfg).then((us) => us.forEach((u) => add("image search", u))));
  }
  await Promise.all(jobs);
  const rank = ["mentioned account", "post", "quoted post", "replied-to post", "linked post", "linked page", "article", "wikipedia", "image search"];
  return out.sort((a, b) => rank.indexOf(a.how) - rank.indexOf(b.how));
}

async function cardFor(item) {
  return renderCard({
    kind: item.kind === "news" ? "news" : "post",
    source: item.author?.name,
    text: item.text,
    name: item.author?.name,
    handle: item.author?.handle,
    avatar: item.author?.avatar,
  });
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// An X account's profile picture, full size (free, via fxtwitter).
export async function profilePicture(handle) {
  try {
    const j = await (await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, { headers: { "User-Agent": UA }, signal: withTimeout(4000) })).json();
    const u = j.user;
    if (!u?.avatar_url) return null;
    return { url: u.avatar_url.replace(/_normal\./, "_400x400.").replace(/_200x200\./, "_400x400."), handle: u.screen_name, name: u.name };
  } catch {
    return null;
  }
}

// Accounts the post is about: @mentions in the text and the quoted post's author (not the poster).
export function accountsIn(item) {
  const me = norm(item.author?.handle);
  const handles = [...String(item.text || "").matchAll(/@([A-Za-z0-9_]{2,15})/g)].map((m) => m[1]);
  if (item.quoted?.author?.handle) handles.push(item.quoted.author.handle);
  return [...new Set(handles)].filter((h) => norm(h) !== me).slice(0, 3);
}

// The coin is about that account when its name or ticker matches the handle or display name
// (Elon posts about @grok -> coin "Grok" -> Grok's own profile picture, the way devs do it).
function aboutAccount(draft, acct) {
  const coin = norm(draft.name) + "|" + norm(draft.ticker);
  return [acct.handle, acct.name].some((x) => norm(x).length >= 3 && (coin.includes(norm(x)) || norm(x).includes(norm(draft.ticker))));
}

// Is the coin about the poster themself? ("Lori Huang Coin" posted by Lori Huang.)
function aboutPoster(item, draft) {
  const n = norm(draft.name) + norm(draft.ticker);
  return [item.author?.handle, item.author?.name].some((x) => norm(x).length >= 3 && n.includes(norm(x)));
}

// The autopilot's pick, in the order real serial devs pick (measured on 678 launches, Nov 9 2026):
//   1. copying a name other devs already launched -> their picture (47 of 56 such names reused one)
//   2. the post's own picture, as it is (news devs: 16 of 19)
//   3. the real picture of the subject the post points to, as it is: the linked article, Instagram,
//      YouTube, game page, quoted or replied-to post (the Google duck, the game logo, the dog photo)
//   4. the poster's profile picture, when the coin is about the poster (7%)
//   5. nothing real: generate the NAME as a picture, a literal or a pun (MAGAZINE = a MAGA hat on a
//      magazine, IMPEACH = a man on a giant peach). Never a scene from the post that isn't the name.
//   6. news only: Wikipedia / image search for the name;  7. a screenshot card, last
// Returns { url } or { buffer }, plus how it was chosen. mode "fast" never generates.
export async function chooseImage(item, draft, cfg, { used = [] } = {}) {
  const mode = cfg.image?.mode || "smart";
  const canGenerate = mode !== "fast" && generatorFor(cfg);
  const fresh = (c) => c && !used.includes(c.url);
  const found = (pick) => squared(pick); // real pictures go up as they are, just cropped square around the subject
  if (item.source === "trend" && item.media?.[0]?.url) return found({ url: item.media[0].url, how: "copied from the devs already running it" });
  // The coin is about an account the post mentions or quotes: that account's own profile picture.
  for (const h of accountsIn(item)) {
    const acct = await profilePicture(h);
    if (acct && aboutAccount(draft, acct) && fresh(acct)) return found({ url: acct.url, how: `@${acct.handle}'s profile picture` });
  }
  // The posts' and links' pictures (no search yet: that costs time and is a guess).
  const all = (await imageCandidates(item, draft, cfg, { search: false })).filter(fresh);
  const of = (...kinds) => all.find((c) => kinds.includes(c.how));
  // A post that links out (article, Instagram, YouTube, game page) usually carries a screenshot of it;
  // devs take the clean picture from the source. Otherwise the post's own picture is the coin.
  const choice = of("linked page", "article") || of("post", "quoted post") || of("linked post", "replied-to post");
  if (choice) return found(choice);
  if (item.author?.avatar && aboutPoster(item, draft) && fresh({ url: item.author.avatar })) return found({ url: item.author.avatar, how: "poster's avatar" });
  if (canGenerate && item.kind !== "news") {
    try {
      return { buffer: await generateImage(imagePrompt(item, draft), cfg), how: "generated (the name as a picture)", url: "generated" };
    } catch (e) {
      draft.warnings = [...(draft.warnings || []), `image generation failed: ${e.message}`];
    }
  }
  // Search hits are a guess about what the name looks like; fine for a name in the news, else a last resort.
  const searched = (await imageCandidates(item, draft, cfg)).filter(fresh).filter((c) => ["wikipedia", "image search"].includes(c.how));
  const hit = item.kind === "news" ? searched[0] : searched.find((c) => c.how === "image search");
  if (hit) return found(hit);
  return { buffer: await cardFor(item), how: "card", url: "card" };
}

// pump.fun shows coin pictures as squares (and circles). A wide banner cropped down the middle loses
// its subject, so crop square around the most interesting region ourselves.
async function squared(pick) {
  try {
    const r = await fetch(pick.url, { headers: { "User-Agent": UA }, signal: withTimeout(8000) });
    if (!r.ok) return pick;
    const src = Buffer.from(await r.arrayBuffer());
    const { width, height } = await sharp(src).metadata();
    if (width && height && Math.abs(width / height - 1) < 0.05) return pick; // already square: upload as it is
    const buffer = await sharp(src).resize(1000, 1000, { fit: "cover", position: sharp.strategy.attention }).png().toBuffer();
    return { ...pick, buffer, cropped: true };
  } catch {
    return pick;
  }
}

// Small previews an agent can look at before choosing.
export async function thumbnail(urlOrBuffer) {
  const buf = Buffer.isBuffer(urlOrBuffer) ? urlOrBuffer : Buffer.from(await (await fetch(urlOrBuffer, { headers: { "User-Agent": UA }, signal: withTimeout(6000) })).arrayBuffer());
  return sharp(buf).resize(256, 256, { fit: "cover" }).jpeg({ quality: 70 }).toBuffer();
}
