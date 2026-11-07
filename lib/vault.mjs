// The vault crank: turn vault money into liquidity, and measure what it earns.
//
// Until now the vault was bookkeeping. Fees accrued, the UI showed a 70/30 split, and not a lamport
// of it ever became liquidity — `vault_lp` was a number in a database, not a position. This is the
// part that makes it real.
//
// WHY A CRANK AND NOT THE PROGRAM. Depositing into an AMM means our program CPI-ing into Raydium,
// which is the largest piece of new on-chain surface in the project — on a program that is already
// carrying real money and has not been audited. The crank gets the same economics with none of that
// risk: `distribute` pays the vault leg out to a wallet, and this deploys it from there. The
// trade-off is honest and worth stating plainly: the LP is held by a key rather than by a PDA, so
// this is custodial. It is a deliberate first step, not the end state.
//
// HOW YIELD IS MEASURED. A constant-product pool has no "claim fees" instruction, because fees are
// not held aside — they accrue INTO the pool, so each LP token is redeemable for progressively more
// of both sides. There is no rewards balance to read and anything that went looking for one would
// report zero forever. Earnings are therefore the growth in what the position is redeemable for,
// against what was put in, which is why `principal` is recorded at deposit and never touched after.
import { PublicKey } from '@solana/web3.js';
import { db } from './db.mjs';
import { cfg, log, warn } from './config.mjs';
import * as CH from './chain.mjs';
import * as R from './raydium.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS vault_lp(
  pool TEXT PRIMARY KEY,
  mint TEXT, quote_mint TEXT,
  lp_amount TEXT DEFAULT '0',
  principal_quote REAL DEFAULT 0,
  principal_tokens REAL DEFAULT 0,
  deposits INTEGER DEFAULT 0,
  first_at INTEGER, last_at INTEGER
)`);

const row = (pool) => db.prepare('SELECT * FROM vault_lp WHERE pool=?').get(pool);

/**
 * What a pool's LP token is worth right now, per unit.
 *
 * Read fresh every time. A ratio cached for even a minute is a ratio somebody can trade against,
 * and every slippage cap below is computed from this.
 */
export async function poolState(pool, mint0, mint1) {
  const conn = CH.conn();
  const [v0, v1, lp] = await Promise.all([
    conn.getTokenAccountBalance(new PublicKey(R.poolVault(pool, mint0))).catch(() => null),
    conn.getTokenAccountBalance(new PublicKey(R.poolVault(pool, mint1))).catch(() => null),
    conn.getTokenSupply(new PublicKey(R.lpMint(pool))).catch(() => null),
  ]);
  if (!v0 || !v1 || !lp) return null;
  const a0 = BigInt(v0.value.amount), a1 = BigInt(v1.value.amount), supply = BigInt(lp.value.amount);
  return { amount0: a0, amount1: a1, lpSupply: supply, dec0: v0.value.decimals, dec1: v1.value.decimals };
}

/**
 * How much LP a deposit of `have0` / `have1` can mint, and what it will actually cost.
 *
 * A constant-product deposit is proportional: you cannot put in more of one side than the pool's
 * current ratio wants, so the binding side decides the size and the other side is whatever that
 * implies. Taking the MINIMUM of the two is what stops a deposit silently donating the surplus.
 */
export function sizeDeposit(st, have0, have1, slippageBps = 100) {
  // ⛔ BIGINT DIVISION BY ZERO THROWS — it does not yield Infinity or NaN the way Number does, it
  // raises RangeError. `lpSupply` was guarded and the two reserves were not, so a pool with nothing
  // on one side took the vault crank down with an uncaught exception instead of being skipped as the
  // degenerate pool it is. A pool can reach that state after a one-sided withdrawal or before its
  // reserves have landed, and neither is our emergency.
  if (!st || st.lpSupply === 0n || !st.amount0 || !st.amount1) return null;
  const by0 = (BigInt(have0) * st.lpSupply) / st.amount0;
  const by1 = (BigInt(have1) * st.lpSupply) / st.amount1;
  const lp = by0 < by1 ? by0 : by1;
  if (lp <= 0n) return null;
  // What that LP actually costs, rounded UP — a deposit that under-states its cost simply fails.
  const need0 = (lp * st.amount0 + st.lpSupply - 1n) / st.lpSupply;
  const need1 = (lp * st.amount1 + st.lpSupply - 1n) / st.lpSupply;
  const pad = (n) => (n * BigInt(10_000 + slippageBps)) / 10_000n;
  return { lp, need0, need1, max0: pad(need0), max1: pad(need1) };
}

/** Record a deposit. `principal` is what went IN and is never adjusted — it is the yield baseline. */
export function recordDeposit({ pool, mint, quoteMint, lp, quoteIn, tokensIn }) {
  const now = Date.now();
  const r = row(pool);
  db.prepare(`INSERT INTO vault_lp(pool,mint,quote_mint,lp_amount,principal_quote,principal_tokens,deposits,first_at,last_at)
    VALUES(?,?,?,?,?,?,1,?,?)
    ON CONFLICT(pool) DO UPDATE SET lp_amount=excluded.lp_amount,
      principal_quote=principal_quote+excluded.principal_quote,
      principal_tokens=principal_tokens+excluded.principal_tokens,
      deposits=deposits+1, last_at=excluded.last_at`)
    .run(pool, mint, quoteMint, String(BigInt(r?.lp_amount || '0') + BigInt(lp)), quoteIn, tokensIn, now, now);
}

/**
 * What every position is worth now, and what it has earned.
 *
 * Earnings are redeemable-value minus principal. On a pool whose price has moved this includes
 * impermanent loss, and it is reported as one number rather than two because that IS the position's
 * result — splitting "fees earned" out from "price moved" would flatter it.
 */
export async function positions() {
  const out = [];
  for (const r of db.prepare('SELECT * FROM vault_lp').all()) {
    const [m0, m1] = R.sortMints(r.mint, r.quote_mint);
    const st = await poolState(r.pool, m0, m1);
    const lp = BigInt(r.lp_amount || '0');
    if (!st || lp === 0n || st.lpSupply === 0n) { out.push({ ...r, redeemable: null }); continue; }
    const tokenIs0 = m0 === r.mint;
    const share0 = (lp * st.amount0) / st.lpSupply;
    const share1 = (lp * st.amount1) / st.lpSupply;
    const quoteNow = Number(tokenIs0 ? share1 : share0) / 10 ** (tokenIs0 ? st.dec1 : st.dec0);
    const tokensNow = Number(tokenIs0 ? share0 : share1) / 10 ** (tokenIs0 ? st.dec0 : st.dec1);
    out.push({
      pool: r.pool, mint: r.mint, quoteMint: r.quote_mint,
      lp: r.lp_amount, deposits: r.deposits, since: r.first_at,
      principal: { quote: r.principal_quote, tokens: r.principal_tokens },
      redeemable: { quote: quoteNow, tokens: tokensNow },
      // Expressed in the quote asset, which is the side the vault was funded in.
      earnedQuote: quoteNow - r.principal_quote,
      sharePct: st.lpSupply > 0n ? Number((lp * 1_000_000n) / st.lpSupply) / 10_000 : 0,
    });
  }
  return out;
}

/**
 * Which graduated launches have a pool the vault could be deployed into.
 *
 * Only graduated ones: before graduation a launch is a bonding curve, and there is no pool to be a
 * liquidity provider in. That is not a limitation to engineer around — a curve has no LPs by
 * construction.
 */
export async function deployable() {
  const launches = await CH.launches();
  const out = [];
  for (const l of launches) {
    if (l.status !== 'graduated') continue;
    const [m0, m1] = R.sortMints(l.mint, String(l.quoteMint));
    const pool = R.poolState(R.ammConfig(0), m0, m1).toBase58?.() || String(R.poolState(R.ammConfig(0), m0, m1));
    const st = await poolState(pool, m0, m1);
    if (!st) continue;   // no pool on chain yet
    out.push({ mint: l.mint, quoteMint: String(l.quoteMint), pool, state: st, vaultPot: l.vaultPot });
  }
  return out;
}

/** A one-line summary for the UI and for the crank's own logging. */
export async function summary() {
  const pos = await positions();
  const earned = pos.reduce((a, p) => a + (p.earnedQuote || 0), 0);
  const principal = pos.reduce((a, p) => a + (p.principal?.quote || 0), 0);
  return {
    positions: pos.length,
    principalQuote: principal,
    earnedQuote: earned,
    // Guarded: a zero principal would make this Infinity, which renders as a very confident lie.
    yieldPct: principal > 0 ? (earned / principal) * 100 : 0,
    custodial: true,
    note: 'LP is held by the vault key, not by a program PDA.',
  };
}
