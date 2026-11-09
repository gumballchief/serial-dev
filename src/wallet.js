import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { FILES, ensureHome } from "./config.js";

// The dev wallet lives outside the repo (~/.serial-dev/wallet.json, Solana CLI format).
// SERIAL_DEV_SECRET (base58) overrides it for servers that inject secrets via env.
export function loadWallet() {
  if (process.env.SERIAL_DEV_SECRET) return Keypair.fromSecretKey(bs58.decode(process.env.SERIAL_DEV_SECRET.trim()));
  if (!fs.existsSync(FILES.wallet)) {
    throw new Error(`No dev wallet yet. Run: serial-dev init   (creates ${FILES.wallet})`);
  }
  const raw = JSON.parse(fs.readFileSync(FILES.wallet, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function createWallet() {
  ensureHome();
  if (fs.existsSync(FILES.wallet)) return { keypair: loadWallet(), created: false };
  const keypair = Keypair.generate();
  fs.writeFileSync(FILES.wallet, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, created: true };
}
