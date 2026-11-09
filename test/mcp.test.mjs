// Talks to the MCP server the way an agent does. Needs network (reads real tweets), spends nothing.
// Usage: npm run test:mcp
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Throwaway home: the test never touches your real settings, saved keys (no paid X feed, no Pinata
// uploads) or launch history. It reads your dev wallet only to show its balance.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "serial-dev-mcp-"));
const realWallet = process.env.SERIAL_DEV_WALLET || path.join(os.homedir(), ".serial-dev", "wallet.json");
const transport = new StdioClientTransport({
  command: "node",
  args: [fileURLToPath(new URL("../bin/serial-dev-mcp.js", import.meta.url))],
  env: {
    ...process.env,
    SERIAL_DEV_HOME: home,
    ...(fs.existsSync(realWallet) ? { SERIAL_DEV_WALLET: realWallet } : {}),
    // never pay for pictures, X data or uploads in tests
    FAL_KEY: "", FAL_KEY_FILE: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TWITTERAPI_KEY: "", PINATA_JWT: "",
  },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (d) => (stderr += d));
const client = new Client({ name: "test-agent", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

let failures = 0;
const call = async (name, args = {}, expect = () => true) => {
  const r = await client.callTool({ name, arguments: args });
  const body = r.content.find((c) => c.type === "text")?.text || "";
  const images = r.content.filter((c) => c.type === "image").length;
  let pass;
  try {
    pass = expect(r.isError ? { error: body } : JSON.parse(body.startsWith("{") || body.startsWith("[") ? body : JSON.stringify(body)), images);
  } catch (e) {
    pass = false;
  }
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${images ? ` (+${images} images)` : ""}: ${body.replace(/\s+/g, " ").slice(0, 160)}`);
};

const instructions = client.getInstructions() || "";
console.log(`${/setup_check/.test(instructions) ? "ok  " : "FAIL"} server instructions tell the agent to run setup_check first`);
if (!/setup_check/.test(instructions)) failures++;

const DOG = "https://x.com/Narra_Creator/status/2119811421399613592";
await call("setup_check", {}, (b) => b.keys && b.keys.pinata && Array.isArray(b.next) && "works" in b && (b.keys.pinata.set || b.keyGuide.pinata.howToGet));
await call("read_playbook", {}, (b) => String(b).includes("Serial Dev Playbook"));
await call("wallet_status", {}, (b) => b.network && b.sources);
await call("draft_coin", { post: DOG }, (b) => b.draft.ticker === "MAX");
await call("draft_coin", { post: "https://x.com/Daily_Express/status/2119815221929717999" }, (b) => b.draft.name === "Russell Brand");
await call("image_options", { post: DOG }, (b, imgs) => b.options.some((o) => o.how === "linked page") && imgs >= 2);
await call("launch_coin", { post: DOG, dry_run: true }, (b) => b.skipped || b.dryRun || b.error);
await call("launch_coin", { name: "Test", ticker: "TEST", dev_buy_sol: 5 }, (b) => /cap/.test(b.error));
await call("generate_image", { prompt: "a dog called max as a memecoin mascot" }, (b) => /FAL_KEY|OPENAI_API_KEY/.test(b.error));
await call("watch_list", { add: ["@elonmusk"], tier: "S" }, (b) => b.accounts.includes("elonmusk [S]"));
await call("sources", { set: { news: true, truth: true } }, (b) => b.news.on && b.truth.on);
await call("next_items", { wait_seconds: 3 }, (b) => Array.isArray(b.items));
await call("sources", { set: { news: false, truth: false } }, (b) => !b.news.on);
await call("stats", {}, (b) => "launches" in b);
await client.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`\nstderr: ${stderr.trim() || "(clean)"}`);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
