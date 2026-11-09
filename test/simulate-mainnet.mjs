// Usage: TRADER=<any funded mainnet wallet> MINT=<a pump coin it holds> npm run test:mainnet   (both optional; it searches recent pump.fun trades if omitted)
// Free mainnet check: simulate every kit transaction as a real, funded pump.fun trader. Nothing is signed or sent.
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { loadConfig } from "../src/config.js";
import * as pump from "../src/pump.js";
const cfg = { ...loadConfig(), network: "mainnet", dryRun: true };
const c = await pump.chain(cfg);
console.log("global ok; createV2Enabled", c.global.createV2Enabled);
// Find a recent pump.fun buyer who holds a coin still on the curve.
const sigs = await c.connection.getSignaturesForAddress(PUMP_PROGRAM_ID, { limit: 150 });
let trader = process.env.TRADER, mint = process.env.MINT;
if (!trader) {
  // Raw JSON-RPC: mainnet now has version-1 transactions that @solana/web3.js v1 can't parse.
  const rpc = async (method, params) => (await (await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
  const sigs = await rpc("getSignaturesForAddress", [PUMP_PROGRAM_ID.toBase58(), { limit: 100 }]);
  for (const s of sigs || []) {
    if (s.err) continue;
    await new Promise((r) => setTimeout(r, 300));
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null);
    if (!tx) continue;
    const payer = tx.transaction.message.accountKeys[0].pubkey;
    const hold = (tx.meta.postTokenBalances || []).find((b) => b.owner === payer && Number(b.uiTokenAmount.amount) > 0);
    if (!hold || tx.meta.postBalances[0] < 0.3e9) continue;
    try { const st = await pump.coinStatus(cfg, hold.mint); if (st.graduated || st.quotedIn) continue; } catch { continue; }
    trader = payer; mint = hold.mint; break;
  }
}
console.log("trader", trader, "mint", mint);
const w = { publicKey: new PublicKey(trader) };
const uri = "https://ipfs.io/ipfs/bafkreiexampleplaceholdermetadatauri";
console.log("LAUNCH no dev buy:", await pump.launch(cfg, w, { name: "Serial Dev Test", ticker: "SDTEST", uri, devBuySol: 0 }));
console.log("LAUNCH + 0.05 dev buy:", await pump.launch(cfg, w, { name: "Serial Dev Test", ticker: "SDTEST", uri, devBuySol: 0.05 }));
console.log("STATUS:", await pump.coinStatus(cfg, mint, w.publicKey));
console.log("BUY 0.01:", await pump.buy(cfg, w, mint, 0.01));
console.log("SELL 50%:", await pump.sell(cfg, w, mint, 50));
console.log("FEES:", await pump.creatorFees(cfg, w, [mint]));

// Prove the lookup-table path fits: compile a real launch + 0.5 SOL dev buy with a full-length IPFS link.
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import { PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
const keys = await pump.launchStaticKeys(c, w.publicKey);
const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: w.publicKey, addresses: keys } });
const longUri = "https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const quote = new BN(0.5e9);
const ixs = await PUMP_SDK.createV2AndBuyInstructions({ global: c.global, mint: Keypair.generate().publicKey, name: "The Longest Coin Name Allowed Ok", symbol: "LONGTICKER", uri: longUri, creator: w.publicKey, user: w.publicKey, mayhemMode: false, solAmount: quote, amount: getBuyTokenAmountFromSolAmount({ global: c.global, feeConfig: c.feeConfig, mintSupply: null, bondingCurve: null, amount: quote, quoteMint: NATIVE_MINT }) });
const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 })];
const { blockhash } = await c.connection.getLatestBlockhash();
console.log("lookup table keys:", keys.length);
console.log("max-size launch+buy WITHOUT table:", pump.compile(w.publicKey, blockhash, [...budget, ...ixs], []).size, "bytes");
console.log("max-size launch+buy WITH table:   ", pump.compile(w.publicKey, blockhash, [...budget, ...ixs], [alt]).size, "bytes (limit 1232)");
