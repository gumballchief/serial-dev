// A coin picture for posts that have none: a clean screenshot-style card of the post or headline.
// Serial-dev tools do the same (J7 calls it a "letter" image). Square PNG, 1000x1000.
import sharp from "sharp";

const W = 1000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text, maxChars, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = next;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "...";
  return lines;
}

async function avatarData(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const png = await sharp(Buffer.from(await r.arrayBuffer())).resize(132, 132).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

// kind: "post" (tweet / truth) or "news" (headline)
export async function renderCard({ text, name, handle, avatar, kind = "post", source = "" }) {
  const clean = String(text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim() || name || "";
  // Bigger type for short posts, like a real screenshot zoomed in.
  const size = clean.length < 40 ? 84 : clean.length < 90 ? 64 : clean.length < 160 ? 50 : 40;
  const lines = wrap(clean, Math.floor(860 / (size * 0.52)), Math.floor(600 / (size * 1.25)));
  const lineH = Math.round(size * 1.25);
  const blockH = lines.length * lineH;
  // Center header + text as one block, like a cropped screenshot.
  const headH = kind === "news" ? 78 : 132;
  const gap = kind === "news" ? 56 : 64;
  const y0 = Math.max(60, Math.round((W - (headH + gap + blockH)) / 2));
  const textY = y0 + headH + gap + Math.round(size * 0.9);
  const av = kind === "post" ? await avatarData(avatar) : null;
  const label = (source || "BREAKING").toUpperCase().slice(0, 24);
  const header =
    kind === "news"
      ? `<rect x="70" y="${y0}" width="${Math.max(220, label.length * 27 + 60)}" height="78" rx="14" fill="#e0245e"/>
         <text x="100" y="${y0 + 54}" font-size="40" font-weight="800" fill="#fff" letter-spacing="2">${esc(label)}</text>`
      : `${av ? `<clipPath id="c"><circle cx="136" cy="${y0 + 66}" r="66"/></clipPath><image href="${av}" x="70" y="${y0}" width="132" height="132" clip-path="url(#c)"/>` : `<circle cx="136" cy="${y0 + 66}" r="66" fill="#cfd9de"/>`}
         <text x="232" y="${y0 + 56}" font-size="44" font-weight="800" fill="#0f1419">${esc((name || handle || "").slice(0, 26))}</text>
         <text x="232" y="${y0 + 110}" font-size="36" fill="#536471">${handle ? "@" + esc(handle.slice(0, 24)) : ""}</text>`;
  const body = lines.map((l, i) => `<text x="70" y="${textY + i * lineH}" font-size="${size}" font-weight="${kind === "news" ? 800 : 500}" fill="#0f1419">${esc(l)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${header}
    ${body}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
