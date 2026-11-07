/**
 * Holdings, reconciled against the only authority there is.
 *
 * ⛔ FOR AN ON-CHAIN COIN, OUR `holdings` TABLE IS A MIRROR, NOT A LEDGER — and a mirror drifts.
 * It is written when we see a trade go past, so anything we did not see is simply not in it: a sale
 * made on another venue, a transfer out, a swap through an aggregator. Checked against mainnet on
 * 7 Oct, one wallet's row claimed 27,999,210 TOMATO while the wallet held none at all. The portfolio
 * showed a position that did not exist, priced it, and put it in the total.
 *
 * That is the other half of what the team reported as "how do these holdings get transferred out —
 * I don't see an option for it". The first half is that there is nothing to transfer: for a DBC
 * coin the tokens are ALREADY in the holder's own wallet, because their own wallet signed the buy.
 * REX Chain is not a custodian and never takes the tokens. But a table that can also be wrong is
 * not something you can tell somebody to trust, so it is made right before it is explained.
 *
 * ⛔ A FAILED READ IS NOT A BALANCE OF ZERO. `heldOf` returns null when it could not reach the
 * chain, and a null MUST leave the row alone. Treating it as zero would delete a real position
 * every time an RPC key expired — which, on the day this was written, was the state of production.
 */
import { db } from './db.mjs';
import { warn } from './config.mjs';
import * as CH from './chain.mjs';

/** Wallets are reconciled at most this often — the read costs one RPC call per distinct mint. */
const EVERY_MS = Number(process.env.RECONCILE_MS || 5 * 60_000);
const last = new Map();

export const dueFor = (wallet) => !last.has(wallet) || Date.now() - last.get(wallet) >= EVERY_MS;

/**
 * Bring one wallet's on-chain rows in line with the chain.
 *
 * Only `venue='dbc'` rows are touched: those are the ones the holder's own wallet owns. A paper row
 * has no on-chain counterpart and reading one would delete it.
 *
 * `chain` is injectable so the rules above — above all the null rule — can be tested without a
 * network: an ES module namespace is frozen, so there is no stubbing it from the outside.
 *
 * @returns {Promise<{checked:number, fixed:number, cleared:number, unknown:number}>}
 */
export async function reconcileWallet(wallet, { chain = CH } = {}) {
  const out = { checked: 0, fixed: 0, cleared: 0, unknown: 0 };
  if (!chain.enabled() || chain.rpcPaused()) return out;
  const rows = db.prepare(`SELECT h.mint, h.amount, t.symbol FROM holdings h JOIN tokens t ON t.mint=h.mint
    WHERE h.wallet=? AND h.amount>0 AND t.venue='dbc'`).all(wallet);
  if (!rows.length) { last.set(wallet, Date.now()); return out; }
  for (const r of rows) {
    out.checked++;
    let held = null;
    try { held = await chain.heldOf(wallet, r.mint); } catch { held = null; }
    if (!held) { out.unknown++; continue; }                       // unreachable: leave the row exactly as it is
    const real = Number(held.total) / 10 ** (held.decimals || 6);
    // A mirror is never going to agree to the last atom with a chain that is still moving, and
    // rewriting a row for a rounding difference would churn the table on every open.
    if (Math.abs(real - r.amount) <= Math.max(1, r.amount * 0.001)) continue;
    if (real <= 0) {
      db.prepare('UPDATE holdings SET amount=0 WHERE wallet=? AND mint=?').run(wallet, r.mint);
      out.cleared++;
    } else {
      db.prepare('UPDATE holdings SET amount=? WHERE wallet=? AND mint=?').run(real, wallet, r.mint);
      out.fixed++;
    }
  }
  last.set(wallet, Date.now());
  if (out.fixed || out.cleared) {
    warn('holdings', `reconciled ${wallet.slice(0, 6)}… — ${out.fixed} corrected, ${out.cleared} cleared,`,
      `${out.unknown} could not be read (left alone)`);
  }
  return out;
}

/** Test seam: forget the per-wallet cooldown. */
export const __resetFor = (wallet) => (wallet ? last.delete(wallet) : last.clear());
