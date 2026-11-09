// A brand-new user, start to finish: no wallet, no keys -> doctor says what to do -> init -> keys set
// (piped, the way a script would) -> env var beats the saved key -> the key value never shows up in output.
// Runs in a throwaway home folder. Needs network (Solana mainnet RPC, Pinata's auth check). Spends nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/serial-dev.js", import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "serial-dev-setup-"));
const FAKE = "fake-pinata-jwt-" + Math.random().toString(36).slice(2);
const clean = { ...process.env, SERIAL_DEV_HOME: home };
for (const k of ["PINATA_JWT", "TWITTERAPI_KEY", "FAL_KEY", "FAL_KEY_FILE", "OPENAI_API_KEY", "BRAVE_API_KEY", "SOLANA_RPC_URL", "SERIAL_DEV_SECRET", "SERIAL_DEV_WALLET", "SERIAL_DEV_NETWORK"]) delete clean[k];

const run = (args, { env = clean, input } = {}) => {
  const r = spawnSync("node", [CLI, ...args], { env, input, encoding: "utf8", timeout: 60_000 });
  return { out: (r.stdout || "") + (r.stderr || ""), code: r.status };
};
let failures = 0;
const check = (name, pass, out) => {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  if (!pass && out) console.log(out.split("\n").map((l) => "     " + l).join("\n"));
};

// 1. Nothing set up yet
let r = run(["doctor"]);
check("doctor with nothing set up says to run init first", /1\. Make the dev wallet: serial-dev init/.test(r.out), r.out);
check("doctor lists the Pinata step with where to get it", /pinata\.cloud.*serial-dev keys set pinata/.test(r.out), r.out);
check("doctor says free things still work", /Truth Social, news and pump\.fun trend feeds/.test(r.out), r.out);

// 2. keys explains every key
r = run(["keys"]);
check("keys explains all six", ["pinata", "twitterapi", "fal", "openai", "rpc", "brave"].every((k) => r.out.includes(`[--] ${k}`)), r.out);

// 3. init makes the wallet and shows the setup check right away
r = run(["init"]);
check("init creates the wallet and prints next steps", /Dev wallet created/.test(r.out) && /Next steps:/.test(r.out) && /Send SOL to/.test(r.out) && /MAINNET/.test(r.out), r.out);
check("wallet file is in the home folder", fs.existsSync(path.join(home, "wallet.json")));

// 4. Save a key the way a script or agent host would (piped in)
r = run(["keys", "set", "pinata"], { input: FAKE + "\n" });
check("keys set saves it and checks it with Pinata (fake key -> rejected)", /saved\s+pinata/.test(r.out) && /rejected/.test(r.out), r.out);
check("key value never printed", !r.out.includes(FAKE), r.out);
const saved = JSON.parse(fs.readFileSync(path.join(home, "keys.json"), "utf8"));
check("saved in keys.json in the home folder", saved.pinata === FAKE);

r = run(["doctor"]);
check("doctor reports the rejected key and how to fix it", /pinata\s+rejected/.test(r.out) && /Pinata key was rejected/.test(r.out), r.out);
check("doctor never prints the key", !r.out.includes(FAKE), r.out);

r = run(["doctor", "--json"]);
const d = JSON.parse(r.out);
check("doctor --json: from saved, not ready", d.keys.pinata.from === "saved" && d.ready === false, r.out);

// 5. Env var wins over the saved key
r = run(["keys"], { env: { ...clean, PINATA_JWT: "from-env" } });
check("env var wins over saved key", /\[ok\] pinata.*set via PINATA_JWT/.test(r.out), r.out);

// 6. Remove
r = run(["keys", "remove", "pinata"]);
check("keys remove", /removed\s+pinata/.test(r.out) && !JSON.parse(fs.readFileSync(path.join(home, "keys.json"), "utf8")).pinata, r.out);

// 7. A launch that reaches the upload without Pinata gives the human-readable fix
// (an empty wallet is caught before this, so call the upload step directly)
const { publishMetadata } = await import("../src/metadata.js");
const msg = await publishMetadata({ name: "Test", ticker: "TEST", image: "x.png" }, { keys: { pinataJwt: "" } }).then(() => "", (e) => e.message);
check("launch without Pinata explains how to get one", /pinata\.cloud.*serial-dev keys set pinata/.test(msg), msg);

fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
