// Everything that touches the chain: launch, buy, sell, coin status, creator fees.
// Built on the official @pump-fun/pump-sdk. Coins are created with create_v2 (Token-2022).
import fs from "node:fs";
import path from "node:path";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  canonicalPumpPoolPda,
  canonicalPumpPoolPdaWithQuote,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  isSolLikeQuoteMint,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-sdk/swap";
import { HOME, coinPage, ensureHome, explorer, rpcFor } from "./config.js";

const TOKEN_DECIMALS = 6;
let ctx = null;

export async function chain(cfg) {
  const rpc = rpcFor(cfg);
  if (!ctx || ctx.rpc !== rpc) {
    const connection = new Connection(rpc, "confirmed");
    ctx = { rpc, connection, sdk: new OnlinePumpSdk(connection), global: null, feeConfig: null, at: 0 };
  }
  if (Date.now() - ctx.at > 60_000) {
    const [global, feeConfig] = await Promise.all([ctx.sdk.fetchGlobal(), ctx.sdk.fetchFeeConfig().catch(() => null)]);
    Object.assign(ctx, { global, feeConfig, at: Date.now() });
  }
  return ctx;
}

const sol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;
const lamportsOf = (s) => new BN(Math.round(Number(s) * LAMPORTS_PER_SOL));

const MAX_TX_BYTES = 1232;

export function compile(payer, blockhash, instructions, alts) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(alts);
  const vtx = new VersionedTransaction(msg);
  let size;
  try {
    size = vtx.serialize().length;
  } catch {
    size = Infinity;
  }
  return { vtx, size };
}

// Every transaction goes through here.
// Dry run: simulate against the real chain, no signatures, nothing spent. The "wallet" can then be
// any address ({ publicKey }), which is how the tests check mainnet for free.
async function send(c, cfg, ixs, signers, alts = []) {
  const budget = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports }),
  ];
  const payer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await c.connection.getLatestBlockhash("confirmed");
  let { vtx, size } = compile(payer, blockhash, [...budget, ...ixs], alts);
  let note;
  if (size > MAX_TX_BYTES && cfg.dryRun && !alts.length) {
    // No lookup table exists yet for this wallet (it's made on the first real launch). Check the
    // pump.fun instructions themselves by simulating without the priority-fee instructions.
    ({ vtx, size } = compile(payer, blockhash, ixs, alts));
    note = "simulated without priority-fee instructions; real launches add them via a lookup table";
  }
  if (size > MAX_TX_BYTES) throw new Error(`Transaction too large for Solana (${size} > ${MAX_TX_BYTES} bytes). Shorten the name or metadata link.`);
  if (cfg.dryRun) {
    const sim = await c.connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = sim.value.logs || [];
    if (sim.value.err === "AccountNotFound") throw new Error(`The dev wallet ${payer.toBase58()} has no SOL on ${cfg.network}. Fund it first.`);
    if (sim.value.err) {
      const e = new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n${logs.slice(-8).join("\n")}`);
      e.logs = logs;
      throw e;
    }
    return { simulated: true, bytes: size, unitsConsumed: sim.value.unitsConsumed, ...(note ? { note } : {}) };
  }
  vtx.sign(signers);
  let signature;
  try {
    signature = await c.connection.sendTransaction(vtx, { maxRetries: 3 });
  } catch (e) {
    if (/AccountNotFound|insufficient (funds|lamports)/i.test(e.message)) throw new Error(`The dev wallet ${payer.toBase58()} doesn't have enough SOL on ${cfg.network}.`);
    throw e;
  }
  const conf = await c.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`Transaction failed on chain: ${JSON.stringify(conf.value.err)} (${signature})`);
  return signature;
}

// Launch + dev buy is ~1240 bytes, just over Solana's limit. A per-wallet address lookup table holds
// the ~20 accounts every launch reuses, so each launch only spells out the few new ones.
// One-time cost: about 0.006 SOL of rent. Made automatically on the first dev-buy launch.
export async function launchStaticKeys(c, user) {
  const build = async () =>
    PUMP_SDK.createV2AndBuyInstructions({
      global: c.global,
      mint: Keypair.generate().publicKey,
      name: "x",
      symbol: "x",
      uri: "x",
      creator: user,
      user,
      amount: new BN(1000),
      solAmount: new BN(1000),
      mayhemMode: false,
    });
  const keysOf = (ixs) => new Set(ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]).map((k) => k.toBase58()));
  const [a, b] = await Promise.all([build(), build()]);
  const kb = keysOf(b);
  const shared = [...keysOf(a)].filter((k) => kb.has(k) && k !== user.toBase58());
  shared.push(ComputeBudgetProgram.programId.toBase58());
  return [...new Set(shared)].map((k) => new PublicKey(k));
}

function altFile(cfg, user) {
  return path.join(HOME, `lookup-${cfg.network}-${user.toBase58()}.json`);
}

export async function lookupTable(cfg, wallet, { create = true } = {}) {
  const c = await chain(cfg);
  const user = wallet.publicKey;
  const file = altFile(cfg, user);
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8")).address;
  } catch {}
  if (saved) {
    const r = await c.connection.getAddressLookupTable(new PublicKey(saved));
    if (r.value) return r.value;
  }
  if (!create || cfg.dryRun) return null;
  const keys = await launchStaticKeys(c, user);
  const recentSlot = await c.connection.getSlot("finalized");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: user, payer: user, recentSlot });
  const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: user, authority: user, lookupTable: address, addresses: keys });
  await send(c, cfg, [createIx, extendIx], [wallet]);
  ensureHome();
  fs.writeFileSync(file, JSON.stringify({ address: address.toBase58(), keys: keys.length }));
  // A table can be used from the slot after it was extended.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const r = await c.connection.getAddressLookupTable(address);
    if (r.value && r.value.state.addresses.length === keys.length) {
      const slot = await c.connection.getSlot("confirmed");
      if (slot > r.value.state.lastExtendedSlot) return r.value;
    }
  }
  throw new Error(`Lookup table ${address.toBase58()} was created but isn't active yet. Try again in a few seconds.`);
}

async function balance(c, pubkey) {
  return c.connection.getBalance(pubkey, "confirmed");
}

export async function walletStatus(cfg, wallet) {
  const c = await chain(cfg);
  const lamports = await balance(c, wallet.publicKey);
  return {
    network: cfg.network,
    address: wallet.publicKey.toBase58(),
    sol: sol(lamports),
    explorer: explorer(cfg, "account", wallet.publicKey.toBase58()),
  };
}

export async function airdrop(cfg, wallet, amountSol = 1) {
  if (cfg.network !== "devnet") throw new Error("Airdrops only exist on devnet.");
  const c = await chain(cfg);
  const sig = await c.connection.requestAirdrop(wallet.publicKey, Math.round(amountSol * LAMPORTS_PER_SOL));
  await c.connection.confirmTransaction(sig, "confirmed");
  return { signature: sig, ...(await walletStatus(cfg, wallet)) };
}

// Create the coin (and optionally the dev buy) in one transaction.
export async function launch(cfg, wallet, { name, ticker, uri, devBuySol = cfg.devBuySol, holderReward = false }) {
  const c = await chain(cfg);
  const user = wallet.publicKey;
  const mint = Keypair.generate();
  const common = { global: c.global, mint: mint.publicKey, name, symbol: ticker, uri, creator: user, user, mayhemMode: false };
  if (holderReward) {
    if (!c.global.isHolderRewardEnabled) throw new Error(`Holder-reward coins are switched off on ${cfg.network}.`);
    common.holderReward = true;
  }
  let ixs;
  const alts = [];
  if (Number(devBuySol) > 0) {
    const table = await lookupTable(cfg, wallet);
    if (table) alts.push(table);
    const quoteAmount = lamportsOf(devBuySol);
    const amount = getBuyTokenAmountFromSolAmount({
      global: c.global,
      feeConfig: c.feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: quoteAmount,
      quoteMint: NATIVE_MINT,
    });
    // The legacy buy has fewer accounts, so create + dev buy still fits in one transaction
    // (the v2 buy pushes it past Solana's 1232-byte limit).
    ixs = await PUMP_SDK.createV2AndBuyInstructions({ ...common, amount, solAmount: quoteAmount });
  } else {
    const { global, ...createArgs } = common;
    ixs = [await PUMP_SDK.createV2Instruction(createArgs)];
  }
  const before = cfg.dryRun ? 0 : await balance(c, user);
  const signature = await send(c, cfg, ixs, [wallet, mint], alts);
  const m = mint.publicKey.toBase58();
  if (signature.simulated) return { dryRun: true, mint: m, devBuySol: Number(devBuySol) || 0, ...signature };
  const after = await balance(c, user);
  return {
    mint: m,
    signature,
    devBuySol: Number(devBuySol) || 0,
    solSpent: sol(before - after),
    page: coinPage(cfg, m),
    tx: explorer(cfg, "tx", signature),
  };
}

// Some pump.fun coins trade against another coin instead of SOL. We only trade SOL coins.
function solCoinOnly(bc) {
  if (!isSolLikeQuoteMint(bc.quoteMint)) {
    throw new Error(`This coin trades against ${bc.quoteMint.toBase58()}, not SOL. serial-dev only trades SOL coins.`);
  }
}

async function tokenProgramOf(c, mint) {
  const info = await c.connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on this network`);
  return info.owner;
}

async function tokenBalance(c, mint, owner, tokenProgram) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  try {
    const r = await c.connection.getTokenAccountBalance(ata, "confirmed");
    return new BN(r.value.amount);
  } catch {
    return new BN(0);
  }
}

export async function buy(cfg, wallet, mintStr, amountSol) {
  const c = await chain(cfg);
  const mint = new PublicKey(mintStr);
  const user = wallet.publicKey;
  const tokenProgram = await tokenProgramOf(c, mint);
  const quoteAmount = lamportsOf(amountSol);
  const before = await balance(c, user);
  const st = await c.sdk.fetchBuyState(mint, user, tokenProgram);
  solCoinOnly(st.bondingCurve);
  let ixs;
  if (st.bondingCurve.complete) {
    const amm = new OnlinePumpAmmSdk(c.connection);
    const state = await amm.swapSolanaState(canonicalPumpPoolPda(mint), user);
    ixs = await PUMP_AMM_SDK.buyQuoteInput(state, quoteAmount, cfg.slippagePct);
  } else {
    const amount = getBuyTokenAmountFromSolAmount({
      global: c.global,
      feeConfig: c.feeConfig,
      mintSupply: st.bondingCurve.tokenTotalSupply,
      bondingCurve: st.bondingCurve,
      amount: quoteAmount,
      quoteMint: st.quoteMint,
      quoteTransferFee: st.quoteTransferFee,
    });
    ixs = await PUMP_SDK.buyV2Instructions({
      global: c.global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: st.bondingCurve,
      associatedUserAccountInfo: st.associatedUserAccountInfo,
      mint,
      user,
      amount,
      quoteAmount,
      slippage: cfg.slippagePct,
      tokenProgram,
      quoteTokenProgram: st.quoteTokenProgram,
    });
  }
  const signature = await send(c, cfg, ixs, [wallet]);
  if (signature.simulated) return { dryRun: true, mint: mintStr, ...signature };
  const after = await balance(c, user);
  return { mint: mintStr, signature, solSpent: sol(before - after), tx: explorer(cfg, "tx", signature) };
}

export async function sell(cfg, wallet, mintStr, percent = 100) {
  const c = await chain(cfg);
  const mint = new PublicKey(mintStr);
  const user = wallet.publicKey;
  const tokenProgram = await tokenProgramOf(c, mint);
  const held = await tokenBalance(c, mint, user, tokenProgram);
  const pct = Math.max(1, Math.min(100, Number(percent) || 100));
  const amount = held.muln(pct).divn(100);
  if (amount.isZero()) throw new Error("This wallet holds none of that coin.");
  const before = await balance(c, user);
  const st = await c.sdk.fetchSellState(mint, user, tokenProgram);
  solCoinOnly(st.bondingCurve);
  let ixs;
  if (st.bondingCurve.complete) {
    const amm = new OnlinePumpAmmSdk(c.connection);
    const state = await amm.swapSolanaState(canonicalPumpPoolPda(mint), user);
    ixs = await PUMP_AMM_SDK.sellBaseInput(state, amount, cfg.slippagePct);
  } else {
    const quoteAmount = getSellSolAmountFromTokenAmount({
      global: c.global,
      feeConfig: c.feeConfig,
      mintSupply: st.bondingCurve.tokenTotalSupply,
      bondingCurve: st.bondingCurve,
      amount,
      quoteTransferFee: st.quoteTransferFee,
    });
    ixs = await PUMP_SDK.sellV2Instructions({
      global: c.global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: st.bondingCurve,
      mint,
      user,
      amount,
      quoteAmount,
      slippage: cfg.slippagePct,
      tokenProgram,
      quoteTokenProgram: st.quoteTokenProgram,
    });
  }
  const signature = await send(c, cfg, ixs, [wallet]);
  if (signature.simulated) return { dryRun: true, mint: mintStr, percent: pct, ...signature };
  const after = await balance(c, user);
  return {
    mint: mintStr,
    signature,
    percent: pct,
    tokensSold: Number(amount.toString()) / 10 ** TOKEN_DECIMALS,
    solReceived: sol(after - before),
    tx: explorer(cfg, "tx", signature),
  };
}

export async function coinStatus(cfg, mintStr, holder) {
  const c = await chain(cfg);
  const mint = new PublicKey(mintStr);
  const bc = await c.sdk.fetchBondingCurve(mint);
  let mcap;
  if (bc.complete || bc.virtualTokenReserves.isZero()) {
    // Graduated: price comes from the PumpSwap pool instead of the curve.
    const amm = new OnlinePumpAmmSdk(c.connection);
    const st = await amm.swapSolanaState(canonicalPumpPoolPdaWithQuote(mint, bc.quoteMint), holder || PublicKey.default).catch(() => null);
    // No pool yet = the curve filled and is waiting to migrate.
    mcap = !st || st.poolBaseAmount.isZero() ? null : st.poolQuoteAmount.mul(bc.tokenTotalSupply).div(st.poolBaseAmount);
  } else {
    mcap = bondingCurveMarketCap({
      mintSupply: bc.tokenTotalSupply,
      virtualQuoteReserves: bc.virtualQuoteReserves,
      virtualTokenReserves: bc.virtualTokenReserves,
    });
  }
  const initialReal = c.global.initialRealTokenReserves;
  const progress = bc.complete
    ? 100
    : initialReal && !initialReal.isZero()
      ? 100 - (Number(bc.realTokenReserves.toString()) / Number(initialReal.toString())) * 100
      : null;
  const solQuoted = isSolLikeQuoteMint(bc.quoteMint);
  const out = {
    mint: mintStr,
    ...(solQuoted ? { marketCapSol: mcap === null ? null : sol(mcap) } : { quotedIn: bc.quoteMint.toBase58(), marketCapInQuote: mcap === null ? null : Number(mcap.toString()) / 10 ** TOKEN_DECIMALS }),
    curveSol: sol(bc.realQuoteReserves),
    bondingProgressPct: progress === null ? null : +progress.toFixed(2),
    graduated: bc.complete,
    creator: bc.creator.toBase58(),
    holderRewardCoin: !!bc.isHolderReward,
    unsweptCreatorFeeSol: bc.creatorFee ? sol(bc.creatorFee) : 0,
    page: coinPage(cfg, mintStr),
  };
  if (holder) {
    const tokenProgram = await tokenProgramOf(c, mint);
    const held = await tokenBalance(c, mint, holder, tokenProgram);
    out.youHoldTokens = Number(held.toString()) / 10 ** TOKEN_DECIMALS;
    out.youHoldPctSupply = +((Number(held.toString()) / Number(bc.tokenTotalSupply.toString())) * 100).toFixed(3);
  }
  return out;
}

// Market cap in SOL for many coins at once (one RPC call per 100 coins).
export async function curves(cfg, mints) {
  const c = await chain(cfg);
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100).map((m) => new PublicKey(m));
    const infos = await c.connection.getMultipleAccountsInfo(batch.map((m) => bondingCurvePda(m)));
    infos.forEach((info, j) => {
      if (!info) return;
      const bc = PUMP_SDK.decodeBondingCurveNullable(info);
      if (bc) out.set(batch[j].toBase58(), bc);
    });
  }
  return out;
}

export async function creatorFees(cfg, wallet, mints = []) {
  const c = await chain(cfg);
  const vault = await c.sdk.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
  let unswept = new BN(0);
  const map = await curves(cfg, mints);
  for (const bc of map.values()) if (bc.creatorFee && bc.creator.equals(wallet.publicKey)) unswept = unswept.add(bc.creatorFee);
  return {
    claimableSol: sol(vault),
    stillOnCurvesSol: sol(unswept),
    totalSol: sol(vault.add(unswept)),
  };
}

// Sweep fees left on our curves into the creator vault, then collect the vault to the wallet.
export async function claimFees(cfg, wallet, mints = []) {
  const c = await chain(cfg);
  const user = wallet.publicKey;
  const before = await balance(c, user);
  const map = await curves(cfg, mints);
  const sweeps = [];
  for (const [m, bc] of map) {
    if (bc.creatorFee && !bc.creatorFee.isZero() && bc.creator.equals(user)) {
      sweeps.push(
        await PUMP_SDK.sweepCreatorFeeInstruction({ payer: user, mint: new PublicKey(m), creator: bc.creator, quoteMint: bc.quoteMint })
      );
    }
  }
  const signatures = [];
  for (let i = 0; i < sweeps.length; i += 6) signatures.push(await send(c, cfg, sweeps.slice(i, i + 6), [wallet]));
  const vault = await c.sdk.getCreatorVaultBalanceBothPrograms(user);
  if (vault.isZero() && !sweeps.length) return { solClaimed: 0, signatures, note: "Nothing to claim yet." };
  const collect = await c.sdk.collectCoinCreatorFeeInstructions(user, user);
  signatures.push(await send(c, cfg, collect, [wallet]));
  const after = await balance(c, user);
  return { solClaimed: sol(after - before), vaultSol: sol(vault), swept: sweeps.length, signatures };
}
