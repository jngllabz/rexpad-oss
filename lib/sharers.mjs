// Paying the people who brought the volume, out of the creator's own claim.
//
// Share & earn lets a launcher give away a slice of THEIR OWN cut to whoever sends buyers. Until
// now the site tracked that and paid nobody: on Meteora a creator's fee is claimed straight to
// their wallet and nothing stood between the pool and them.
//
// ⛔ SO THE PAYMENT RIDES INSIDE THE CREATOR'S OWN CLAIM TRANSACTION. We build that transaction,
// so the sharers' transfers go in it and settle atomically with the claim: either the creator
// receives their fee and the sharers receive their slice, or neither happens. No custody, no
// second rail, and nothing of the creator's is moved by anyone but the creator.
//
// The alternative — taking the slice before the creator sees it — would mean routing their fee
// through us, which is custody of other people's money for a referral feature. Not worth it.
import { db } from './db.mjs';
import { cfg } from './config.mjs';

/** Pay at most this many sharers in one claim; the rest keep their `owed` for the next one. */
export const MAX_SHARERS_PER_CLAIM = 6;
/** Below this a transfer costs more in rent and fee than it moves. */
const DUST = 1e-9;

/**
 * Divide `pool` between sharers in proportion to the volume each brought.
 *
 * ⛔ LARGEST REMAINDER, IN RAW UNITS. Rounding each share independently leaves dust that belongs
 * to somebody stranded in the creator's wallet, every single claim. The parts sum to EXACTLY the
 * pool — that is the property the test pins, because an allocation that does not is a slow leak.
 */
export function splitByVolume(rows, poolRaw) {
  const pool = BigInt(poolRaw);
  if (pool <= 0n) return [];
  const total = rows.reduce((a, r) => a + Number(r.volume || 0), 0);
  if (!(total > 0)) return [];
  const parts = rows.map((r) => {
    const exact = (Number(r.volume) / total) * Number(pool);
    const floor = BigInt(Math.floor(exact));
    return { ...r, amountRaw: floor, frac: exact - Math.floor(exact) };
  });
  let left = pool - parts.reduce((a, p) => a + p.amountRaw, 0n);
  // Hand the leftover units out to the biggest fractions first — the standard largest-remainder
  // rule, and the only one that is both exact and not systematically unfair to anybody.
  parts.sort((a, b) => b.frac - a.frac);
  for (let i = 0; left > 0n && i < parts.length; i++, left--) parts[i].amountRaw += 1n;
  return parts.filter((p) => p.amountRaw > 0n);
}

/**
 * Who is owed what out of a claim of `claimedRaw` quote units, and what is payable right now.
 *
 * `accrue` is the split of THIS claim. `pay` is what the transaction will actually carry: the
 * largest outstanding balances, capped, so a long tail does not blow the transaction size.
 */
export function sharerPlan({ token, claimedRaw, decimals, rexHeldUsd }) {
  const bps = Math.max(0, Math.min(10_000, Number(token?.ref_share_bps) || 0));
  if (!bps || !(Number(claimedRaw) > 0)) return { bps, poolRaw: 0n, accrue: [], pay: [], carried: 0 };
  const poolRaw = (BigInt(claimedRaw) * BigInt(bps)) / 10_000n;

  // ⛔ THE $REX HOLD IS A CONTINUING REQUIREMENT, not a one-time gate — the same rule the paper
  // curve applies. A sharer who qualified and then sold stops earning, and their share goes to the
  // sharers who are still holding rather than back to the creator.
  const all = db.prepare('SELECT referrer, volume, owed, paid FROM ref_credit WHERE mint=? AND volume > 0').all(token.mint);
  const eligible = cfg.refHoldUsd > 0 && typeof rexHeldUsd === 'function'
    ? all.filter((r) => { try { return rexHeldUsd(r.referrer) >= cfg.refHoldUsd; } catch { return false; } })
    : all;

  const accrue = splitByVolume(eligible, poolRaw);
  // What each is owed AFTER this claim is added: previous balance plus this slice.
  const owedAfter = new Map(eligible.map((r) => [r.referrer, Number(r.owed || 0)]));
  for (const a of accrue) owedAfter.set(a.referrer, (owedAfter.get(a.referrer) || 0) + Number(a.amountRaw) / 10 ** decimals);

  const pay = [...owedAfter.entries()]
    .map(([referrer, owed]) => ({ referrer, owed }))
    .filter((r) => r.owed > DUST)
    .sort((a, b) => b.owed - a.owed)
    .slice(0, MAX_SHARERS_PER_CLAIM)
    .map((r) => ({ ...r, amountRaw: BigInt(Math.floor(r.owed * 10 ** decimals)) }))
    .filter((r) => r.amountRaw > 0n);

  const carried = [...owedAfter.values()].reduce((a, v) => a + v, 0)
    - pay.reduce((a, r) => a + Number(r.amountRaw) / 10 ** decimals, 0);
  return { bps, poolRaw, accrue, pay, carried: Math.max(0, carried) };
}

/** Record what this claim added to each sharer's balance. Called when the claim is BUILT. */
export function accrueOwed(mint, accrue, decimals) {
  if (!accrue?.length) return;
  const up = db.prepare('UPDATE ref_credit SET owed = owed + ? WHERE mint=? AND referrer=?');
  for (const a of accrue) up.run(Number(a.amountRaw) / 10 ** decimals, mint, a.referrer);
}

/**
 * Settle what a CONFIRMED transaction actually paid.
 *
 * ⛔ READ BACK FROM THE CHAIN, NEVER FROM THE PLAN. A built transaction is not a sent one and a
 * sent one is not a confirmed one; decrementing `owed` at build time would forgive a debt that a
 * cancelled wallet prompt never paid. The caller passes what it read off the transaction.
 */
export function settlePaid(mint, paidByWallet) {
  const up = db.prepare('UPDATE ref_credit SET owed = MAX(0, owed - ?), paid = paid + ? WHERE mint=? AND referrer=?');
  let total = 0;
  for (const [wallet, amount] of Object.entries(paidByWallet || {})) {
    if (!(amount > 0)) continue;
    up.run(amount, amount, mint, wallet);
    total += amount;
  }
  if (total > 0) db.prepare('UPDATE tokens SET ref_paid = ref_paid + ? WHERE mint=?').run(total, mint);
  return total;
}
