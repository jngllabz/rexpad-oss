// Raydium LaunchLab as a SECOND venue, because Meteora cannot be the only one.
//
// ⛔ WHY THIS EXISTS. Meteora's DBC refuses any quote mint that charges a transfer fee — the
// program answers `6081 QuoteMintHasNonZeroTransferFee` from token.rs:232, and no token badge
// changes it. That is five of our quote assets: $GP (3%), $ZCAT (3%), $MASK (3%), $SI (1%) and
// $ALLINU (1%). While DBC is the only venue, a $GP pair is simply impossible here, and we spent
// days telling the owner it was waiting on a badge from Meteora that would have achieved nothing.
//
// Raydium's LaunchLab takes a taxed quote. Santa Markets has launched GP-paired coins on it for
// weeks, which is the whole reason this file is a port and not a design.
//
// This file is CHAIN CODE ONLY. It knows nothing about our tokens table; the caller owns the rows,
// exactly as lib/meteora.mjs does for the DBC venue.
import BN from 'bn.js';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, getMint, getTransferFeeConfig,
         getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
         createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token';
import { LAUNCHPAD_PROGRAM, CREATE_CPMM_POOL_PROGRAM, LaunchpadPool, LaunchpadConfig, PlatformConfig,
         Curve, CpmmCreatorFeeOn, initializeWithToken2022, buyExactInInstruction, sellExactInInstruction,
         claimCreatorFee, claimPlatformFeeFromVault, createPlatformConfig, getPdaLaunchpadAuth,
         getPdaLaunchpadPoolId, getPdaLaunchpadVaultId, getPdaPlatformId, getPdaPlatformVault,
         getPdaCreatorVault, getPdaPlatformFeeVaultAuth, getPdaCreatorFeeVaultAuth,
         getCpmmPdaPoolId, getPdaLaunchpadConfigId } from '@raydium-io/raydium-sdk-v2';
import { warn } from './config.mjs';
import { meta } from './db.mjs';
import { QUOTES } from './prices.mjs';

// ⛔ LAZY, NOT A MODULE-SCOPE Connection. RPC_URL may be a comma-separated list with failover, and
// a connection built at import time misses the breaker that keeps this site up when Helius throttles.
const conn = async () => (await import('./chain.mjs')).conn();

export const LL_PROGRAM = LAUNCHPAD_PROGRAM;
const AUTH = getPdaLaunchpadAuth(LL_PROGRAM).publicKey;
export const LL_AUTH = AUTH;
export const LL_SUPPLY = 1_000_000_000, LL_DEC = 6;
export const LL_SELL = 793_100_000;          // LaunchLab's standard 79.31%; the rest seeds the Raydium pool
export const LL_START_MCAP_USD = Number(process.env.LAUNCHLAB_START_MCAP_USD || 5000);

/**
 * The pair tokens LaunchLab has a curve config for.
 *
 * ⛔ A CONFIG IS CREATED BY RAYDIUM, NOT BY US — but it is a PDA, so whether one exists is a
 * question the chain can answer. This used to be three addresses typed in by hand, and a
 * hand-maintained list of what another protocol supports is a list that is wrong the day after it
 * is written. It was: Raydium has had configs for ZCAT, SI, MASK and ALLINU all along, and because
 * they were not in this map the site never offered them a venue. All four are Token-2022 with a
 * transfer fee (3%, 1%, 3%, 1%), which is exactly why Meteora refuses them — error 6081,
 * quoteMintHasNonZeroTransferFee — so they sat greyed out as "no Meteora badge" with no second
 * venue picking them up, while $GP, which charges the same 3%, launched there happily.
 *
 * Julz: "On the metas only stonk seems to be only one that works." STONK is the one plain SPL mint
 * with no transfer fee in that whole category, so it was the only one Meteora would take. He was
 * reading the symptom exactly right.
 *
 * So the config is now DERIVED and then verified against the chain, and the three seeds below are
 * only a floor that keeps the venue alive when an RPC is down. A pair Raydium supports is offered
 * the moment it is asked about, without anyone editing this file.
 */
export const LL_SEED_CONFIGS = {
  GP:   'YvrkNk3enhjN3JMLoDuNv2sKyTQJikvKCv5pRWBhB3J',
  GLDx: 'Crvp3VHo4eqyARzFsnwygu3Y9aWgfy9zupQtcVVuZN2K',
  SOL:  '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX',
};
/** curve type 0, index 0 — the pairing confirmed to reproduce all three seeds above exactly. */
export const llConfigIdFor = (mint) =>
  getPdaLaunchpadConfigId(LL_PROGRAM, new PublicKey(mint), 0, 0).publicKey.toBase58();

// Which quotes actually have a config, asked of the chain once and cached. One getMultipleAccounts
// covers every quote we have, so this costs a single call rather than one per pair.
const configCache = { at: 0, ok: new Map() };   // symbol -> config id
let configInflight = null;
export function llPairs() {
  const live = [...configCache.ok.keys()];
  return live.length ? live : Object.keys(LL_SEED_CONFIGS);
}
/** Does this venue have a curve config for that mint? Answered from the cached scan. */
export function llHasConfig(mint) {
  const sym = Object.keys(QUOTES).find((k) => QUOTES[k].mint === mint);
  return !!sym && llPairs().includes(sym);
}
export function llConfigs() {
  if (configCache.ok.size) return Object.fromEntries(configCache.ok);
  return { ...LL_SEED_CONFIGS };
}
/** Refresh the set of pairs this venue can carry. Safe to call often; it self-throttles. */
export async function llRefreshConfigs({ force = false } = {}) {
  if (configInflight) return configInflight;
  if (!force && Date.now() - configCache.at < 30 * 60_000 && configCache.ok.size) return null;
  configInflight = (async () => {
    try {
      const syms = Object.keys(QUOTES);
      const ids = syms.map((s) => { try { return llConfigIdFor(QUOTES[s].mint); } catch { return null; } });
      const want = syms.map((s, i) => ({ s, id: ids[i] })).filter((x) => x.id);
      const c = await conn();
      const found = new Map();
      for (let i = 0; i < want.length; i += 100) {
        const slice = want.slice(i, i + 100);
        const infos = await c.getMultipleAccountsInfo(slice.map((x) => new PublicKey(x.id)));
        slice.forEach((x, j) => {
          const a = infos[j];
          // Owned by the LaunchLab program, or it is not a curve config whatever else it may be.
          if (a && a.owner?.toBase58?.() === LL_PROGRAM.toBase58()) found.set(x.s, x.id);
        });
      }
      // ⛔ A FAILED OR EMPTY SCAN MUST NOT RETIRE A WORKING VENUE. Finding nothing is what a
      // throttled RPC looks like, and treating it as "Raydium supports no pairs" would turn the
      // whole second venue off for everyone on a bad minute.
      if (found.size) { configCache.ok = found; configCache.at = Date.now(); }
      else warn('launchlab', 'config scan found nothing — keeping the previous pair list');
      return found.size;
    } catch (e) { warn('launchlab', `config scan: ${e.message}`); return 0; }
    finally { configInflight = null; }
  })();
  return configInflight;
}
/** A quote in the shape this venue needs, built from our own table so decimals are never retyped. */
export function llQuoteOf(mintOrKey) {
  const CFG = llConfigs();
  const key = Object.keys(CFG).find((k) => k === String(mintOrKey)
    || QUOTES[k]?.mint === mintOrKey || k.toUpperCase() === String(mintOrKey || '').toUpperCase());
  if (!key) return null;
  const q = QUOTES[key];
  if (!q) return null;
  return { key, symbol: q.symbol, mint: q.mint, dec: q.decimals, config: CFG[key],
    native: q.mint === NATIVE_MINT.toBase58(), prog: null };
}
/** Which token program a quote lives under, asked of the chain — never assumed from the symbol. */
async function progOf(Q) {
  if (Q.prog) return Q.prog;
  const { tokenProgramOf } = await import('./chain.mjs');
  Q.prog = await tokenProgramOf(Q.mint);
  return Q.prog;
}

/** The site's LaunchLab platform. One account, created once by the owner. Until it exists this venue is OFF. */
export const llPlatformId = () => process.env.LAUNCHLAB_PLATFORM || meta.get('launchlab_platform') || null;
export const llEnabled = () => !!llPlatformId();

const cache = new Map();
async function memo(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.v;
  const v = await fn(); cache.set(key, { at: Date.now(), v }); return v;
}
export const llForget = (pool) => { cache.delete('pool:' + pool); };
const bn = (v) => new BN(String(v));
const supplyRaw = () => bn(LL_SUPPLY).mul(bn(10).pow(bn(LL_DEC)));
const sellRaw = () => bn(LL_SELL).mul(bn(10).pow(bn(LL_DEC)));
const str = (a) => Buffer.from(a).toString('utf8').replace(/\0+$/, '');

/** The platform's settings, from the chain: its fee on curve trades, the launcher's, where LP goes. */
export async function llPlatform({ fresh = false } = {}) {
  const id = llPlatformId();
  if (!id) throw new Error('LaunchLab launches are not open yet');
  return memo('platform:' + id, fresh ? 0 : 5 * 60_000, async () => {
    const a = await (await conn()).getAccountInfo(new PublicKey(id));
    if (!a) throw new Error('the LaunchLab platform account is missing');
    const p = PlatformConfig.decode(a.data);
    return { id, feeRate: p.feeRate, creatorFeeRate: p.creatorFeeRate,
      feeBps: Number(p.feeRate) / 100, creatorFeeBps: Number(p.creatorFeeRate) / 100,
      claimWallet: p.platformClaimFeeWallet.toBase58(), taxAuth: p.transferFeeExtensionAuth.toBase58(),
      cpConfig: p.cpConfigId.toBase58(), name: str(p.name), web: str(p.web),
      lp: { platform: Number(p.platformScale) / 1e4, creator: Number(p.creatorScale) / 1e4, burn: Number(p.burnScale) / 1e4 } };
  });
}
async function llConfig(configId) {
  return memo('config:' + configId, 3600_000, async () => {
    const a = await (await conn()).getAccountInfo(new PublicKey(configId));
    if (!a) throw new Error('LaunchLab curve config not found');
    return LaunchpadConfig.decode(a.data);
  });
}
export async function llPool(pool, { fresh = false } = {}) {
  return memo('pool:' + pool, fresh ? 0 : 8_000, async () => {
    const a = await (await conn()).getAccountInfo(new PublicKey(pool));
    if (!a) throw new Error('LaunchLab pool not found');
    if (!a.owner.equals(LL_PROGRAM)) throw new Error('not a LaunchLab pool');
    return LaunchpadPool.decode(a.data);
  });
}
async function feeCfg(mint, prog) {
  try {
    const m = await memo('mint:' + mint, 10 * 60_000, async () => getMint(await conn(), new PublicKey(mint), 'confirmed', prog));
    return getTransferFeeConfig(m) || undefined;
  } catch { return undefined; }
}

/**
 * The curve that opens at `startMcapQuote`, in the pair token: what it raises and where it ends.
 * The start price is linear in the amount raised, so it is measured once and scaled.
 */
export function llCurveFor(startMcapQuote, Q) {
  const supply = supplyRaw(), totalSell = sellRaw();
  const curve = Curve.getCurve(0);
  const probe = bn(10).pow(bn(Q.dec + 6));
  const p = curve.getInitParam({ supply, totalFundRaising: probe, totalSell, totalLockedAmount: bn(0), migrateFee: bn(0) });
  const k = Number(p.b.toString()) / Number(p.a.toString()) * Number(supply.toString()) / Number(probe.toString());
  const raiseUi = startMcapQuote / k;
  if (!(raiseUi > 0) || !Number.isFinite(raiseUi)) {
    throw new Error('this pair cannot carry a curve at that size — the pair token is worth too little per unit');
  }
  const raiseRaw = bn(BigInt(Math.ceil(raiseUi * 10 ** Q.dec)).toString());
  const q = curve.getInitParam({ supply, totalFundRaising: raiseRaw, totalSell, totalLockedAmount: bn(0), migrateFee: bn(0) });
  const startPx = Number(q.b.toString()) / 10 ** Q.dec / (Number(q.a.toString()) / 10 ** LL_DEC);
  const endPx = (Number(q.b.toString()) + Number(raiseRaw.toString())) / 10 ** Q.dec
    / ((Number(q.a.toString()) - Number(totalSell.toString())) / 10 ** LL_DEC);
  return { supply, totalSell, raiseRaw, raise: Number(raiseRaw.toString()) / 10 ** Q.dec,
    startPx, endPx, startMcapQuote: startPx * LL_SUPPLY, endMcapQuote: endPx * LL_SUPPLY };
}
export const llPoolId = (mint, Q) => getPdaLaunchpadPoolId(LL_PROGRAM, new PublicKey(mint), new PublicKey(Q.mint)).publicKey;
export const llVaults = (pool, mint, quoteMint) => ({
  vaultBase: getPdaLaunchpadVaultId(LL_PROGRAM, new PublicKey(pool), new PublicKey(mint)).publicKey,
  vaultQuote: getPdaLaunchpadVaultId(LL_PROGRAM, new PublicKey(pool), new PublicKey(quoteMint)).publicKey,
});

/** The launch instruction: mint and curve in one. The mint keypair signs alongside the launcher. */
export async function llInitIx({ owner, mint, Q, name, symbol, uri, taxBps = 0, raiseRaw }) {
  const P = await llPlatform();
  const o = new PublicKey(owner), m = new PublicKey(mint), QPK = new PublicKey(Q.mint);
  const pool = llPoolId(mint, Q), v = llVaults(pool, mint, Q.mint);
  const config = await llConfig(Q.config);
  const supply = supplyRaw(), totalSell = sellRaw(), raise = bn(raiseRaw);
  // Refuse here rather than letting the program refuse after the launcher has signed and paid.
  Curve.checkParam({ supply, totalFundRaising: raise, totalSell, totalLockedAmount: bn(0), decimals: LL_DEC, config, migrateType: 'cpmm' });
  const ix = initializeWithToken2022(LL_PROGRAM, o, o, new PublicKey(Q.config), new PublicKey(P.id), AUTH,
    pool, m, QPK, v.vaultBase, v.vaultQuote, await progOf(Q), LL_DEC, name, symbol, uri,
    { type: 'ConstantCurve', totalSellA: totalSell, migrateType: 'cpmm', supply, totalFundRaisingB: raise },
    bn(0), bn(0), bn(0), CpmmCreatorFeeOn.OnlyTokenB,
    { transferFeeBasePoints: taxBps, maxinumFee: supply });
  return { ix, pool: pool.toBase58(), platform: P };
}
/** The pool as it will be the instant it is created, for quoting a first buy that rides in the launch. */
function freshPoolInfo({ raiseRaw }) {
  const supply = supplyRaw(), totalSell = sellRaw();
  const p = Curve.getCurve(0).getInitParam({ supply, totalFundRaising: bn(raiseRaw), totalSell, totalLockedAmount: bn(0), migrateFee: bn(0) });
  return { virtualA: p.a, virtualB: p.b, realA: bn(0), realB: bn(0), totalSellA: totalSell, totalFundRaisingB: bn(raiseRaw), supply };
}
const freshTax = (taxBps) => ({
  transferFeeConfigAuthority: AUTH, withdrawWithheldAuthority: AUTH, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: BigInt(supplyRaw().toString()), transferFeeBasisPoints: taxBps },
  newerTransferFee: { epoch: 0n, maximumFee: BigInt(supplyRaw().toString()), transferFeeBasisPoints: taxBps },
});

/**
 * Quote and instructions for a buy on the curve, paid in the pair token.
 *
 * ⛔ THE QUOTE'S OWN TRANSFER FEE IS PASSED TO THE CURVE MATHS. This is the whole reason the venue
 * exists: $GP takes 3% in transit, so the pool receives less than the buyer sent, and a curve that
 * does not know that prices every trade wrong. `transferFeeConfigB` is what makes a taxed pair
 * honest — and what Meteora declines to do at all.
 */
export async function llBuy({ owner, mint, Q, creator, amountIn, slippageBps = 300, fresh = null, quoteOnly = false }) {
  const P = await llPlatform(), config = await llConfig(Q.config);
  const pool = llPoolId(mint, Q), v = llVaults(pool, mint, Q.mint);
  const poolInfo = fresh ? freshPoolInfo(fresh) : await llPool(pool.toBase58(), { fresh: !quoteOnly });
  if (!fresh && poolInfo.status !== 0) throw new Error('this coin has left its curve — it trades on Raydium now');
  const inRaw = bn(BigInt(Math.floor(Number(amountIn) * 10 ** Q.dec)).toString());
  if (inRaw.lte(bn(0))) throw new Error('amount must be positive');
  const prog = await progOf(Q);
  const [feeA, feeB, slot] = await Promise.all([
    fresh ? freshTax(fresh.taxBps || 0) : feeCfg(mint, TOKEN_2022_PROGRAM_ID),
    prog.equals(TOKEN_2022_PROGRAM_ID) ? feeCfg(Q.mint, TOKEN_2022_PROGRAM_ID) : undefined,
    memo('slot', 8_000, async () => (await conn()).getSlot()),
  ]);
  const c = Curve.buyExactIn({ poolInfo, amountB: inRaw, protocolFeeRate: config.tradeFeeRate,
    platformFeeRate: P.feeRate, curveType: config.curveType, shareFeeRate: bn(0),
    creatorFeeRate: P.creatorFeeRate, transferFeeConfigA: feeA, transferFeeConfigB: feeB, slot });
  const netA = c.amountA.amount.sub(c.amountA.fee ?? bn(0));
  const slip = Math.min(3000, Math.max(10, Math.round(Number(slippageBps) || 300)));
  const minA = netA.mul(bn(10_000 - slip)).div(bn(10_000));
  const spendRaw = c.amountB.lt(inRaw) ? c.amountB : inRaw;      // the curve can only sell what is left
  const pxBefore = (Number(poolInfo.virtualB.toString()) + Number(poolInfo.realB.toString()))
    / (Number(poolInfo.virtualA.toString()) - Number(poolInfo.realA.toString()));
  const gross = Number(c.amountA.amount.toString());
  const paidNet = Number(spendRaw.toString())
    - Number(c.splitFee.platformFee.add(c.splitFee.protocolFee).add(c.splitFee.creatorFee).add(c.splitFee.shareFee).toString())
    - Number((c.transferFeeB ?? bn(0)).toString());
  const out = { pool: pool.toBase58(), quoteSymbol: Q.symbol,
    out: Number(netA.toString()) / 10 ** LL_DEC, outMin: Number(minA.toString()) / 10 ** LL_DEC,
    spent: Number(spendRaw.toString()) / 10 ** Q.dec,
    fee: Number(c.splitFee.platformFee.toString()) / 10 ** Q.dec, feeBps: P.feeBps,
    curveFees: { platformBps: P.feeBps, creatorBps: P.creatorFeeBps, protocolBps: Number(config.tradeFeeRate) / 100 },
    priceImpactPct: gross > 0 && pxBefore > 0 ? Math.max(0, (paidNet / gross / pxBefore - 1) * 100) : 0,
    capped: c.amountB.lt(inRaw) };
  if (quoteOnly) return out;
  const o = new PublicKey(owner), m = new PublicKey(mint), QPK = new PublicKey(Q.mint);
  const ataA = getAssociatedTokenAddressSync(m, o, false, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(QPK, o, false, prog);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(o, ataA, o, m, TOKEN_2022_PROGRAM_ID)];
  let closeAfter = false;
  if (Q.native) {
    // ⛔ A wrapped-SOL account the buyer ALREADY HAD is left exactly as it was. Closing someone
    // else's standing wSOL balance because we happened to use it is not ours to do.
    closeAfter = !(await (await conn()).getAccountInfo(ataB).catch(() => null));
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(o, ataB, o, QPK, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: o, toPubkey: ataB, lamports: BigInt(spendRaw.toString()) }),
      createSyncNativeInstruction(ataB));
  }
  ixs.push(buyExactInInstruction(LL_PROGRAM, o, AUTH, new PublicKey(Q.config), new PublicKey(P.id), pool,
    ataA, ataB, v.vaultBase, v.vaultQuote, m, QPK, TOKEN_2022_PROGRAM_ID, prog,
    getPdaPlatformVault(LL_PROGRAM, new PublicKey(P.id), QPK).publicKey,
    getPdaCreatorVault(LL_PROGRAM, new PublicKey(creator), QPK).publicKey, spendRaw, minA, bn(0)));
  if (Q.native && closeAfter) ixs.push(createCloseAccountInstruction(ataB, o, o, [], TOKEN_PROGRAM_ID));
  return { ...out, ixs };
}
/** Quote and instructions for a sale into the curve. */
export async function llSell({ owner, mint, Q, creator, amountRaw, slippageBps = 300, quoteOnly = false, unwrap = true }) {
  const P = await llPlatform(), config = await llConfig(Q.config);
  const pool = llPoolId(mint, Q), v = llVaults(pool, mint, Q.mint);
  const poolInfo = await llPool(pool.toBase58(), { fresh: !quoteOnly });
  if (poolInfo.status !== 0) throw new Error('this coin has left its curve — it trades on Raydium now');
  const inRaw = bn(amountRaw);
  if (inRaw.lte(bn(0))) throw new Error('amount must be positive');
  const prog = await progOf(Q);
  const [feeA, feeB, slot] = await Promise.all([
    feeCfg(mint, TOKEN_2022_PROGRAM_ID),
    prog.equals(TOKEN_2022_PROGRAM_ID) ? feeCfg(Q.mint, TOKEN_2022_PROGRAM_ID) : undefined,
    memo('slot', 8_000, async () => (await conn()).getSlot()),
  ]);
  const c = Curve.sellExactIn({ poolInfo, amountA: inRaw, protocolFeeRate: config.tradeFeeRate,
    platformFeeRate: P.feeRate, curveType: config.curveType, shareFeeRate: bn(0),
    creatorFeeRate: P.creatorFeeRate, transferFeeConfigA: feeA, transferFeeConfigB: feeB, slot });
  const slip = Math.min(3000, Math.max(10, Math.round(Number(slippageBps) || 300)));
  const outRaw = c.amountB, minB = outRaw.mul(bn(10_000 - slip)).div(bn(10_000));
  const out = { pool: pool.toBase58(), quoteSymbol: Q.symbol, outRaw: BigInt(outRaw.toString()),
    out: Number(outRaw.toString()) / 10 ** Q.dec, outMin: Number(minB.toString()) / 10 ** Q.dec,
    fee: Number(c.splitFee.platformFee.toString()) / 10 ** Q.dec, feeBps: P.feeBps };
  if (quoteOnly) return out;
  const o = new PublicKey(owner), m = new PublicKey(mint), QPK = new PublicKey(Q.mint);
  const ataA = getAssociatedTokenAddressSync(m, o, false, TOKEN_2022_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(QPK, o, false, prog);
  const closeAfter = Q.native && unwrap && !(await (await conn()).getAccountInfo(ataB).catch(() => null));
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(o, ataB, o, QPK, prog),
    sellExactInInstruction(LL_PROGRAM, o, AUTH, new PublicKey(Q.config), new PublicKey(P.id), pool,
      ataA, ataB, v.vaultBase, v.vaultQuote, m, QPK, TOKEN_2022_PROGRAM_ID, prog,
      getPdaPlatformVault(LL_PROGRAM, new PublicKey(P.id), QPK).publicKey,
      getPdaCreatorVault(LL_PROGRAM, new PublicKey(creator), QPK).publicKey, inRaw, minB, bn(0))];
  if (closeAfter) ixs.push(createCloseAccountInstruction(ataB, o, o, [], TOKEN_PROGRAM_ID));
  return { ...out, ixs };
}

/** Everything the board needs about a coin still on its curve. */
export async function llMarket(pool, Q, { fresh = false } = {}) {
  const p = await llPool(pool, { fresh });
  const price = (Number(p.virtualB.toString()) + Number(p.realB.toString())) / 10 ** Q.dec
    / ((Number(p.virtualA.toString()) - Number(p.realA.toString())) / 10 ** LL_DEC);
  const raised = Number(p.realB.toString()) / 10 ** Q.dec;
  const target = Number(p.totalFundRaisingB.toString()) / 10 ** Q.dec;
  const endPx = (Number(p.virtualB.toString()) + Number(p.totalFundRaisingB.toString())) / 10 ** Q.dec
    / ((Number(p.virtualA.toString()) - Number(p.totalSellA.toString())) / 10 ** LL_DEC);
  return { status: p.status, price, raised, target, progress: target > 0 ? Math.min(1, raised / target) : 0,
    sold: Number(p.realA.toString()) / 10 ** LL_DEC, endPrice: endPx, creator: p.creator.toBase58(),
    platformId: p.platformId.toBase58(), configId: p.configId.toBase58(),
    supply: Number(p.supply.toString()) / 10 ** LL_DEC };
}
/** The Raydium pool a graduated coin moved to. Null until it exists on chain. */
export async function llGraduatedPool(mint, Q) {
  const P = await llPlatform();
  const a = new PublicKey(mint), b = new PublicKey(Q.mint);
  const [m0, m1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  const id = getCpmmPdaPoolId(CREATE_CPMM_POOL_PROGRAM, new PublicKey(P.cpConfig), m0, m1).publicKey;
  const acct = await (await conn()).getAccountInfo(id).catch(() => null);
  return acct ? id.toBase58() : null;
}

/** What a launcher has earned on the curve and not claimed. One vault per launcher per pair token. */
export async function llCreatorFees(creator, Q) {
  const vault = getPdaCreatorVault(LL_PROGRAM, new PublicKey(creator), new PublicKey(Q.mint)).publicKey;
  const b = await (await conn()).getTokenAccountBalance(vault).catch(() => null);
  return { vault: vault.toBase58(), raw: BigInt(b?.value?.amount || 0),
    amount: Number(b?.value?.amount || 0) / 10 ** Q.dec, symbol: Q.symbol };
}
export async function llClaimCreatorIxs({ creator, Q }) {
  const o = new PublicKey(creator), QPK = new PublicKey(Q.mint), prog = await progOf(Q);
  const ata = getAssociatedTokenAddressSync(QPK, o, false, prog);
  const vault = getPdaCreatorVault(LL_PROGRAM, o, QPK).publicKey;
  const existed = !!(await (await conn()).getAccountInfo(ata).catch(() => null));
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(o, ata, o, QPK, prog),
    claimCreatorFee(LL_PROGRAM, o, getPdaCreatorFeeVaultAuth(LL_PROGRAM).publicKey, vault, ata, QPK, prog)];
  if (Q.native && !existed) ixs.push(createCloseAccountInstruction(ata, o, o, [], TOKEN_PROGRAM_ID));
  return ixs;
}
/** The platform's own fee vaults, one per pair token. */
export async function llPlatformFees() {
  const P = await llPlatform();
  const out = [];
  for (const key of Object.keys(llConfigs())) {
    const Q = llQuoteOf(key); if (!Q) continue;
    const vault = getPdaPlatformVault(LL_PROGRAM, new PublicKey(P.id), new PublicKey(Q.mint)).publicKey;
    const b = await (await conn()).getTokenAccountBalance(vault).catch(() => null);
    out.push({ Q, vault: vault.toBase58(), raw: BigInt(b?.value?.amount || 0),
      amount: Number(b?.value?.amount || 0) / 10 ** Q.dec });
  }
  return out;
}
export async function llClaimPlatformIxs({ claimWallet, Q }) {
  const P = await llPlatform();
  const o = new PublicKey(claimWallet), QPK = new PublicKey(Q.mint), prog = await progOf(Q);
  const ata = getAssociatedTokenAddressSync(QPK, o, false, prog);
  const vault = getPdaPlatformVault(LL_PROGRAM, new PublicKey(P.id), QPK).publicKey;
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(o, ata, o, QPK, prog),
    claimPlatformFeeFromVault(LL_PROGRAM, new PublicKey(P.id), o, getPdaPlatformFeeVaultAuth(LL_PROGRAM).publicKey, vault, ata, QPK, prog)];
  if (Q.native) ixs.push(createCloseAccountInstruction(ata, o, o, [], TOKEN_PROGRAM_ID));
  return ixs;
}

/**
 * The one-time platform account. `admin` signs and pays.
 *
 * Created once, by the owner, and this venue is dark until it exists — which is deliberate: a
 * half-configured venue in the launch form is worse than no venue at all.
 */
export function llCreatePlatformIx({ admin, claimWallet, rewardWallet, feeRate, creatorFeeRate,
  lp = { platform: 0, creator: 0, burn: 100 }, cpConfig,
  name = 'REX Chain', web = 'https://rex.fun', img = 'https://rex.fun/brand/rex-glyph.png' }) {
  if (creatorFeeRate > 5000) throw new Error('LaunchLab caps the launcher fee at 0.5%');
  if (feeRate > 50000) throw new Error('LaunchLab caps the platform fee at 5%');
  if (Math.round(lp.platform + lp.creator + lp.burn) !== 100) throw new Error('the LP split must add up to 100%');
  const a = new PublicKey(admin), c = new PublicKey(claimWallet);
  const id = getPdaPlatformId(LL_PROGRAM, a).publicKey;
  const ix = createPlatformConfig(LL_PROGRAM, a, c, c, c, id, new PublicKey(cpConfig), new PublicKey(rewardWallet),
    { platformScale: bn(Math.round(lp.platform * 1e4)), creatorScale: bn(Math.round(lp.creator * 1e4)), burnScale: bn(Math.round(lp.burn * 1e4)) },
    bn(feeRate), bn(creatorFeeRate), name, web, img, bn(0));
  return { ix, id: id.toBase58() };
}

/**
 * Create the site's LaunchLab platform. Once, ever.
 *
 * ⛔ THE FEE CLAIMER IS THE ADMIN AND THE CLAIM WALLET, deliberately. It is the wallet that already
 * collects Meteora's fees and that the waterfall already distributes from, so LaunchLab's platform
 * fees land in exactly the same place and need no second rail. Making it the reward wallet too
 * means the tax withheld by coins launched here is collectable by the same key.
 *
 * Until this account exists `llEnabled()` is false and the venue does not appear anywhere.
 */
export async function llCreatePlatform({
  feeRate = 20_000,          // 2% of every curve trade, matching Santa Markets
  creatorFeeRate = 5_000,    // 0.5% to the launcher — the program's maximum
  lp = { platform: 0, creator: 0, burn: 100 },   // the LP is burned at graduation
  cpConfig = 'CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ',
  name, web, img, execute = false,
} = {}) {
  const { Keypair, sendAndConfirmTransaction, Transaction } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const { cfg } = await import('./config.mjs');
  if (!cfg.feeClaimerKey) throw new Error('no FEE_CLAIMER_KEY — the platform has no signer');
  const k = Keypair.fromSecretKey(bs58.decode(cfg.feeClaimerKey));
  const me = k.publicKey.toBase58();
  const made = llCreatePlatformIx({ admin: me, claimWallet: me, rewardWallet: me,
    feeRate, creatorFeeRate, lp, cpConfig, ...(name ? { name } : {}), ...(web ? { web } : {}), ...(img ? { img } : {}) });

  const c = await conn();
  // ⛔ IF IT ALREADY EXISTS, ADOPT IT RATHER THAN FAILING. The address is a PDA of the admin key, so
  // a half-finished attempt leaves an account that a second run would otherwise collide with.
  if (await c.getAccountInfo(new PublicKey(made.id))) {
    meta.set('launchlab_platform', made.id);
    return { id: made.id, existed: true, platform: await llPlatform({ fresh: true }) };
  }
  const NEED = 12_000_000;                       // the account's rent, ~0.0075 SOL, plus room
  const have = await c.getBalance(k.publicKey, 'confirmed');
  if (have < NEED) {
    throw new Error(`the fee claimer holds ${(have / 1e9).toFixed(4)} SOL and creating the platform `
      + `needs about ${(NEED / 1e9).toFixed(4)} — fund ${me} and try again.`);
  }
  if (!execute) return { id: made.id, plan: true, feeRate, creatorFeeRate, lp, cpConfig, admin: me, lamports: NEED };

  const tx = new Transaction().add(made.ix);
  tx.feePayer = k.publicKey;
  const sig = await sendAndConfirmTransaction(c, tx, [k], { commitment: 'confirmed' });
  meta.set('launchlab_platform', made.id);
  warn('launchlab', `platform created ${made.id} ${sig.slice(0, 12)}…`);
  return { id: made.id, signature: sig, platform: await llPlatform({ fresh: true }) };
}
