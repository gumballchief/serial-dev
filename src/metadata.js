import fs from "node:fs";
import path from "node:path";

// Coin picture + info JSON -> a public URI that pump.fun and wallets can read.
// Uses Pinata (free tier works: set PINATA_JWT). Or skip uploading by passing your own `uri`.

async function pinataUpload(cfg, blob, filename) {
  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("network", "public");
  fd.append("name", filename);
  const r = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.keys.pinataJwt}` },
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  const cid = j?.data?.cid;
  if (!r.ok || !cid) throw new Error(`Pinata upload failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  return `${cfg.keys.pinataGateway}/ipfs/${cid}`;
}

async function fetchImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't download image ${url} (${r.status})`);
  const type = r.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) throw new Error(`Not an image: ${url} (${type})`);
  const blob = await r.blob();
  const ext = type.split("/")[1]?.split(";")[0] || "jpg";
  return { blob, ext };
}

export function metadataJson(draft, imageUrl) {
  return {
    name: draft.name,
    symbol: draft.ticker,
    description: draft.description,
    image: imageUrl || "",
    showName: true,
    createdOn: "https://pump.fun",
    twitter: draft.twitter || "",
    telegram: draft.telegram || "",
    website: draft.website || "",
  };
}

export async function publishMetadata(draft, cfg) {
  if (draft.uri) return { uri: draft.uri, image: draft.image || null, uploaded: false };
  if (!cfg.keys.pinataJwt) {
    throw new Error(
      "No Pinata key, so there's nowhere to host the coin's picture and info. Get a free key at pinata.cloud (API Keys > New Key > Admin > copy the JWT), then run: serial-dev keys set pinata. Or pass a ready metadata `uri`. `serial-dev doctor` shows everything that's missing."
    );
  }
  let imageUrl = null;
  const base = draft.ticker.toLowerCase();
  if (draft.imageBuffer) {
    imageUrl = await pinataUpload(cfg, new Blob([draft.imageBuffer], { type: "image/png" }), `${base}.png`);
  } else if (draft.image && fs.existsSync(draft.image)) {
    const ext = path.extname(draft.image).slice(1).toLowerCase() || "png";
    imageUrl = await pinataUpload(cfg, new Blob([fs.readFileSync(draft.image)], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), `${base}.${ext}`);
  } else if (draft.image) {
    const { blob, ext } = await fetchImage(draft.image);
    imageUrl = await pinataUpload(cfg, blob, `${base}.${ext}`);
  }
  const json = new Blob([JSON.stringify(metadataJson(draft, imageUrl))], { type: "application/json" });
  const uri = await pinataUpload(cfg, json, `${draft.ticker.toLowerCase()}.json`);
  return { uri, image: imageUrl, uploaded: true };
}
