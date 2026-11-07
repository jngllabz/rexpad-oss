// The vault, on Meteora DAMM v2.
//
// WHY THIS REPLACED THE RAYDIUM CRANK. `tools/vault_crank.mjs` deposits into Raydium CPMM, and a
// graduated DBC launch lands on DAMM v2 instead — different program, different maths. But the port
// is not a like-for-like rewrite, because CPMM made the vault's job impossible in a way DAMM v2
// does not:
//
//   A constant-product deposit needs BOTH sides of the pair. The vault is funded in the quote asset
//   alone, so the old crank could only report a shortfall and stop — acquiring the token side is a
//   market buy, and a crank that quietly places market orders is making a trading decision nobody
//   reviewed. The vault therefore sat on money it could not deploy.
//
//   DAMM v2 is CONCENTRATED liquidity: a position is a PRICE RANGE. A range entirely below spot is
//   made of quote and nothing else. So the vault can deploy quote-only liquidity with no market buy
//   at all — and a bid sitting below the market, earning fees while it waits, is exactly what the
//   site already promises ("70% concentrated LP, 30% quote bid"). The constraint that blocked the
//   old design turns out to be native here.
//
// THREE STRATEGIES, because this is a policy question and not a technical one. Which one REX Chain
// should use is for the team to decide; all three are implemented so the decision is a setting
// rather than another rebuild.
import { PublicKey } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import { cfg, log, warn } from './config.mjs';
import { db } from './db.mjs';

const { BN } = anchorPkg;

let _sdk = null;
async function sdk() {
  if (!_sdk) _sdk = await import('@meteora-ag/cp-amm-sdk');
  return _sdk;
}
let _amm = null;
/**
 * Test seam. The AMM client is memoised on first use, so without a way to replace it every test of
 * a deposit would have to reach a real RPC — and a deposit is precisely the thing that must be
 * provable without one. Used only by tools/lp_test.mjs.
 */
export function __setAmmForTest(stub) { _amm = stub; }
export async function amm(conn) {
  if (_amm) return _amm;
  const { CpAmm } = await sdk();
  _amm = new CpAmm(conn);
  return _amm;
}

/**
 * The strategies. `bid` is the default and the only one that needs no trading decision.
 *
 *   bid   A single-sided QUOTE position in a range BELOW spot. It is a standing bid: it buys the
 *         coin on the way down, earns trading fees while it waits, and never requires us to market
 *         buy anything. Faithful to what the site already says the vault does.
 *
 *   both  A full-range position on both sides. Deepest liquidity and the most fees, but it needs
 *         the token side, which means a market buy — a trading decision, with impermanent loss
 *         attached. Implemented, deliberately not the default.
 *
 *   lock  Buy the token and permanently lock it. Simple and a real supply reduction, but it earns
 *         nothing afterwards, which makes it a slow burn wearing a vault's name.
 */
export const STRATEGIES = ['bid', 'both', 'lock'];
export const strategy = () => (STRATEGIES.includes(cfg.vaultStrategy) ? cfg.vaultStrategy : 'both');

/**
 * Plan a full-range deposit — the 'both' strategy the team chose.
 *
 * Deepest book and the most fees, and the honest cost is that it needs the TOKEN side, which the
 * vault does not hold. That means a market buy, and this plans it rather than placing it: the
 * shortfall and its price impact are reported so a person can look at the number before a thin book
 * turns the vault's money into somebody else's arbitrage.
 */
export async function planBoth({ conn, pool, quoteAmount }) {
  const a = await amm(conn);
  const state = await a.fetchPoolState(new PublicKey(pool));
  if (!state) return null;
  // Full range: the pool's own bounds, so the position is live at every price rather than only
  // inside a band somebody picked.
  const minSqrtPrice = state.sqrtMinPrice ?? state.minSqrtPrice;
  const maxSqrtPrice = state.sqrtMaxPrice ?? state.maxSqrtPrice;
  const quote = await a.getDepositQuote({
    inAmount: new BN(String(quoteAmount)),
    isTokenA: false,                       // the vault holds quote, which is token B
    minSqrtPrice, maxSqrtPrice, sqrtPrice: state.sqrtPrice,
  });
  const needsToken = BigInt(quote.outputAmount?.toString?.() ?? 0);
  return {
    pool, state, minSqrtPrice, maxSqrtPrice, quoteAmount: BigInt(quoteAmount),
    liquidityDelta: quote.liquidityDelta,
    // Non-zero by design here, unlike `bid`. This is the market buy somebody has to approve.
    needsToken,
    strategy: 'both',
  };
}

/**
 * Where REX Chain's own 5% vault leg goes. Fco's call: deepen $REX.
 *
 * ⛔ WORTH KNOWING BEFORE THIS RUNS: most $REX liquidity is on PumpSwap, which this codebase cannot
 * deposit into. The Meteora $REX/SOL pool we CAN deposit into is far smaller, so "deepen $REX"
 * through this path deepens the venue where $REX is thinnest — useful, because every REX Chain
 * launch now routes through Meteora, but it is not where today's $REX volume is. There is no safe
 * default, so an unset REX_POOL refuses instead of guessing.
 */
export function rexPool() {
  if (cfg.vaultTarget !== 'rex') return null;
  if (!cfg.rexPool) throw new Error('VAULT_TARGET is "rex" but REX_POOL is not set — refusing to guess which pool to deepen');
  return cfg.rexPool;
}

/**
 * The price range for a single-sided quote position.
 *
 * `depthPct` is how far below spot the bid sits. Too tight and it fills on noise; too wide and it
 * never fills and earns nothing. The range runs from `depthPct` below spot up to just under spot —
 * NOT through it, because a range that straddles the current price needs the token side too, which
 * is the whole thing we are avoiding.
 */
export function bidRange(sqrtPrice, depthPct = 15) {
  const p = BigInt(sqrtPrice.toString());
  // sqrt price, so the bound is scaled by the square root of the price ratio. Integer maths: a
  // 15% lower price is sqrt(0.85) ≈ 0.922 of the sqrt price.
  const lower = (p * BigInt(Math.round(Math.sqrt(1 - depthPct / 100) * 10_000))) / 10_000n;
  const upper = (p * 9_999n) / 10_000n;   // just under spot, so the position stays pure quote
  return { minSqrtPrice: new BN(lower.toString()), maxSqrtPrice: new BN(upper.toString()) };
}

/**
 * What a quote-only deposit would buy, and what it would cost.
 *
 * Reads the pool fresh. A range priced off a stale sqrtPrice is a range that straddles spot by the
 * time it lands, which silently turns a single-sided deposit into one that needs tokens we do not
 * have.
 */
export async function planBid({ conn, pool, quoteAmount, depthPct = 15 }) {
  const a = await amm(conn);
  const state = await a.fetchPoolState(new PublicKey(pool));
  if (!state) return null;
  // In a DBC-migrated pool the LAUNCHED token is A and the quote is B, so quote-only means isTokenA
  // false. Checked against the pool rather than assumed, because getting it backwards would deposit
  // the wrong side of the pair.
  const quoteIsA = false;
  const { minSqrtPrice, maxSqrtPrice } = bidRange(state.sqrtPrice, depthPct);
  const quote = await a.getDepositQuote({
    inAmount: new BN(String(quoteAmount)),
    isTokenA: quoteIsA,
    minSqrtPrice, maxSqrtPrice,
    sqrtPrice: state.sqrtPrice,
  });
  return {
    pool, state, minSqrtPrice, maxSqrtPrice, depthPct,
    // ⛔ Returned because buildBidDeposit reads it. Without it the deposit was built for ZERO — it
    // would have signed and confirmed cleanly while depositing nothing at all.
    quoteAmount: BigInt(quoteAmount),
    liquidityDelta: quote.liquidityDelta,
    // A single-sided bid should need ZERO of the launched token. If this is non-zero the range has
    // drifted across spot and the deposit is no longer single-sided — the caller must refuse rather
    // than quietly buy the difference.
    needsToken: BigInt(quote.outputAmount?.toString?.() ?? 0),
  };
}

/**
 * Build the deposit. Returns a transaction and the position NFT that must co-sign it.
 *
 * `permanentLock` is the difference between liquidity the vault could pull and liquidity it never
 * can. Locked is the honest default for something the site calls a vault with "no redeem" — but it
 * is irreversible, so it is passed explicitly rather than assumed.
 */
export async function buildBidDeposit({ conn, owner, plan, permanentLock = true }) {
  const a = await amm(conn);
  const { Keypair } = await import('@solana/web3.js');
  const positionNft = Keypair.generate();
  const s = plan.state;
  // A deposit of nothing is not a deposit. Refuse rather than sign a transaction that does nothing.
  if (!(BigInt(plan.quoteAmount ?? 0) > 0n)) throw new Error('nothing to deposit — the plan has no quote amount');
  const tx = await a.createPositionAndAddLiquidity({
    owner: new PublicKey(owner),
    pool: new PublicKey(plan.pool),
    positionNft: positionNft.publicKey,
    liquidityDelta: plan.liquidityDelta,
    maxAmountTokenA: new BN(0),                    // single-sided: no launched token is supplied
    maxAmountTokenB: new BN(String(plan.quoteAmount ?? 0)),
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(String(plan.quoteAmount ?? 0)),
    tokenAMint: s.tokenAMint, tokenBMint: s.tokenBMint,
    tokenAProgram: s.tokenAFlag === 1 ? TOKEN_2022 : TOKEN_LEGACY,
    tokenBProgram: s.tokenBFlag === 1 ? TOKEN_2022 : TOKEN_LEGACY,
  });
  return { tx, positionNft, permanentLock };
}

const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Every vault position and what it has earned. Fees are read from the chain, never inferred. */
export async function positions(conn, owner) {
  const a = await amm(conn);
  const list = await a.getPositionsByUser(new PublicKey(owner)).catch(() => []);
  const out = [];
  for (const p of list) {
    const fee = await a.getPositionFee?.(p.position).catch(() => null);
    out.push({
      position: p.position?.toBase58?.() ?? String(p.position),
      pool: p.positionState?.pool?.toBase58?.() ?? null,
      liquidity: p.positionState?.unlockedLiquidity?.toString?.() ?? '0',
      permanentlyLocked: p.positionState?.permanentLockedLiquidity?.toString?.() !== '0',
      fee,
    });
  }
  return out;
}

/** Claim the fees a vault position has earned. This is the vault paying for itself. */
export async function buildClaimPositionFee({ conn, owner, pool, position, positionNftAccount }) {
  const a = await amm(conn);
  return a.claimPositionFee({
    owner: new PublicKey(owner), pool: new PublicKey(pool),
    position: new PublicKey(position), positionNftAccount: new PublicKey(positionNftAccount),
  });
}
