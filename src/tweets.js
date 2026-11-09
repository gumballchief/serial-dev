// Get a tweet as one clean shape, whichever source it came from.
//
// Tweet = {
//   id, url, text, createdAt (ms),
//   author: { handle, name, followers, avatar, verified },
//   media: [{ type: "photo" | "video", url }],
//   likes, retweets, views, isReply, isRetweet, quoted (Tweet | null)
// }

const UA = "serial-dev";

export function parseTweetId(input) {
  const s = String(input).trim();
  const m = s.match(/status(?:es)?\/(\d{5,25})/);
  if (m) return m[1];
  if (/^\d{5,25}$/.test(s)) return s;
  throw new Error(`Not a tweet link or id: ${s}`);
}

function ms(dateLike) {
  if (!dateLike) return Date.now();
  if (typeof dateLike === "number") return dateLike < 1e12 ? dateLike * 1000 : dateLike;
  const t = Date.parse(dateLike);
  return Number.isNaN(t) ? Date.now() : t;
}

export function fromTwitterApi(t) {
  if (!t || !t.id) return null;
  const a = t.author || {};
  const mediaList = t.extendedEntities?.media || t.extended_entities?.media || t.entities?.media || t.media || [];
  const media = mediaList
    .map((m) => {
      const isVideo = m.type === "video" || m.type === "animated_gif";
      const url = m.media_url_https || m.media_url || m.url;
      return url ? { type: isVideo ? "video" : "photo", url } : null;
    })
    .filter(Boolean);
  return {
    id: String(t.id),
    url: t.url || (a.userName ? `https://x.com/${a.userName}/status/${t.id}` : `https://x.com/i/status/${t.id}`),
    text: t.text || "",
    createdAt: ms(t.createdAt),
    author: {
      handle: a.userName || "",
      name: a.name || a.userName || "",
      followers: a.followers ?? 0,
      avatar: (a.profilePicture || "").replace("_normal.", "_400x400."),
      verified: !!(a.isBlueVerified || a.isVerified),
    },
    media,
    likes: t.likeCount ?? 0,
    retweets: t.retweetCount ?? 0,
    views: t.viewCount ?? 0,
    isReply: !!t.isReply,
    isRetweet: !!t.retweeted_tweet,
    quoted: t.quoted_tweet ? fromTwitterApi(t.quoted_tweet) : null,
    replyToId: t.inReplyToId || null,
    links: (t.entities?.urls || []).map((u) => u.expanded_url).filter(Boolean),
    source: "twitterapi.io",
  };
}

export function fromFx(t) {
  if (!t || !t.id) return null;
  const a = t.author || {};
  const media = [
    ...(t.media?.photos || []).map((p) => ({ type: "photo", url: p.url })),
    ...(t.media?.videos || []).map((v) => ({ type: "video", url: v.thumbnail_url || v.url })),
  ].filter((m) => m.url);
  return {
    id: String(t.id),
    url: t.url || `https://x.com/${a.screen_name}/status/${t.id}`,
    text: t.text || "",
    createdAt: ms(t.created_timestamp || t.created_at),
    author: {
      handle: a.screen_name || "",
      name: a.name || a.screen_name || "",
      followers: a.followers ?? 0,
      avatar: (a.avatar_url || "").replace("_200x200.", "_400x400."),
      verified: !!a.verification?.verified,
    },
    media,
    likes: t.likes ?? 0,
    retweets: t.retweets ?? 0,
    views: t.views ?? 0,
    isReply: !!t.replying_to,
    isRetweet: false,
    quoted: t.quote ? fromFx(t.quote) : null,
    replyToId: t.replying_to_status || null,
    links: (t.raw_text?.facets || []).filter((f) => f.type === "url").map((f) => f.replacement).filter(Boolean),
    source: "fxtwitter",
  };
}

// twitterapi.io when a key is set (fast, paid), otherwise the free fxtwitter API.
export async function getTweet(input, cfg) {
  const id = parseTweetId(input);
  if (cfg?.keys?.twitterapi) {
    const r = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${id}`, {
      headers: { "x-api-key": cfg.keys.twitterapi },
    });
    const j = await r.json().catch(() => ({}));
    const t = (j.tweets || []).find((x) => String(x.id) === id);
    if (t) return fromTwitterApi(t);
  }
  const r = await fetch(`https://api.fxtwitter.com/status/${id}`, { headers: { "User-Agent": UA } });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 200 || !j.tweet) throw new Error(`Couldn't load tweet ${id} (${j.message || r.status}). It may be deleted or private.`);
  return fromFx(j.tweet);
}

// Latest tweets from one account (twitterapi.io key required). Used by poll mode.
export async function getLatestTweets(handle, cfg) {
  if (!cfg?.keys?.twitterapi) throw new Error("TWITTERAPI_KEY is not set");
  const u = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
  u.searchParams.set("userName", handle.replace(/^@/, ""));
  const r = await fetch(u, { headers: { "x-api-key": cfg.keys.twitterapi } });
  const j = await r.json().catch(() => ({}));
  if (j.status === "error") throw new Error(j.msg || "twitterapi.io error");
  const list = j.data?.tweets || j.tweets || [];
  return list.map(fromTwitterApi).filter(Boolean);
}
