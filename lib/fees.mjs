// Claim a DBC pool's trading fee and divide it into REX Chain's buckets.
//
// THIS IS THE PART THAT USED TO BE THE CHAIN'S JOB. Our own program enforced five buckets on every
// swap: holders, creator, vault, burn, buyback, with a 5% ceiling the program itself rejected. A
// Meteora pool has ONE fee. The buckets still exist, but they are now how the CLAIMED fee is
// divided afterwards — arithmetic this module runs rather than arithmetic the chain guarantees.
//
// That is strictly weaker and it is worth being honest about: a crank that stops running is a crank
// that stops paying. Four things make the weaker version safe enough to ship, and all four are
// load-bearing rather than decoration:
//
//   1. A CLAIM IS RECORDED BEFORE IT IS SPLIT. The signature goes into the database the moment the
//      chain confirms it, in its own transaction, before a single bucket is credited. A crash
//      between the two leaves a claim with no split, which the next run finishes — never a split
//      with no claim, which would be money invented from nothing.
//   2. CLAIMS ARE IDEMPOTENT BY SIGNATURE. Replaying the same confirmed claim is a no-op, so a
//      retry after a timeout cannot double-credit.
//   3. THE SPLIT IS DERIVED FROM THE STORED BPS, never retyped. The same numbers the launcher chose
//      and the UI displayed are the ones that divide the money.
//   4. THE REMAINDER STAYS IN THE POT. Integer division leaves dust; assigning it to whichever
//      bucket is computed last would quietly favour that bucket on every run forever. It carries
//      to the next run instead.
import { db, tx } from './db.mjs';
import { cfg, log, warn } from './config.mjs';
import { QUOTES } from './prices.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS fee_claims(
  sig TEXT PRIMARY KEY,
  mint TEXT, pool TEXT, side TEXT,
  quote_amount TEXT DEFAULT '0', base_amount TEXT DEFAULT '0',
  quote_mint TEXT,
  claimed_at INTEGER,
  split_at INTEGER,
  remainder TEXT DEFAULT '0'
)`);
// Older databases predate the remainder column; adding it is harmless if it is already there.
try { db.exec("ALTER TABLE fee_claims ADD COLUMN remainder TEXT DEFAULT '0'"); } catch {}
db.exec('CREATE INDEX IF NOT EXISTS fee_claims_mint ON fee_claims(mint, claimed_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS fee_claims_unsplit ON fee_claims(split_at) WHERE split_at IS NULL');

/** The buckets, in bps OF THE CLAIMED PARTNER FEE. They must sum to 10_000. */
export function bucketsOf(t) {
  const b = {
    holder: t.holder_bps ?? 0,
    vault: t.vault_bps ?? 0,
    burn: t.burn_bps ?? 0,
    buyback: t.buyback_bps ?? 0,
  };
  const named = b.holder + b.vault + b.burn + b.buyback;
  // Whatever the launcher did not allocate is REX Chain's income, which is also what funds the
  // five-wallet waterfall. Deriving it as the remainder rather than storing it separately is what
  // makes the four buckets and REX's share incapable of summing to anything but the whole.
  return { ...b, rex: Math.max(0, 10_000 - named) };
}

/**
 * Divide a claimed amount into the buckets.
 *
 * Integer maths on base units throughout. Every bucket is rounded DOWN and the shortfall is
 * returned as `remainder` rather than handed to one of them — see note 4 above.
 */
export function splitClaim(amountBase, buckets) {
  const total = BigInt(amountBase);
  if (total <= 0n) return { parts: {}, remainder: 0n };
  const parts = {};
  let assigned = 0n;
  for (const [name, bps] of Object.entries(buckets)) {
    const cut = (total * BigInt(bps)) / 10_000n;
    if (cut > 0n) parts[name] = cut;
    assigned += cut;
  }
  return { parts, remainder: total - assigned };
}

/** Has this claim already been recorded? Idempotency, keyed on the chain's own signature. */
export const claimSeen = (sig) => !!db.prepare('SELECT 1 FROM fee_claims WHERE sig=?').get(sig);

/**
 * Record a confirmed claim. Called the moment the chain confirms, BEFORE any split.
 *
 * Deliberately does not credit anything. A claim recorded with `split_at` NULL is the signal to the
 * next run that money has arrived and has not yet been divided — which is recoverable. The reverse
 * is not.
 */
export function recordClaim({ sig, mint, pool, side, quoteAmount, baseAmount, quoteMint }) {
  db.prepare(`INSERT OR IGNORE INTO fee_claims(sig,mint,pool,side,quote_amount,base_amount,quote_mint,claimed_at,split_at)
    VALUES(?,?,?,?,?,?,?,?,NULL)`)
    .run(sig, mint, pool, side, String(quoteAmount), String(baseAmount), quoteMint, Date.now());
}

/** Claims that have landed but not yet been divided, oldest first. */
export const unsplit = () => db.prepare('SELECT * FROM fee_claims WHERE split_at IS NULL ORDER BY claimed_at ASC').all();

/**
 * Quote-mint decimals that have been READ FROM THE CHAIN, keyed by mint.
 *
 * `applySplit` has to be synchronous — it runs inside the same database transaction as the
 * "this one is done" stamp, and splitting that across an await is how a claim gets credited twice.
 * So the chain read happens before it, through `verifyDecimals`, and lands here.
 */
const verified = new Map();

/** The verified decimals for a quote mint, or null if nothing has read it yet. */
export const decimalsFor = (quoteMint) => {
  const d = verified.get(String(quoteMint));
  return Number.isInteger(d) ? d : null;
};

/**
 * Read a quote mint's decimals from the chain and remember them, so `applySplit` can be sync.
 *
 * Returns the decimals, or null when the chain could not be read — and a null is NOT cached,
 * because a single failed read must not make every later split wrong for the life of the process.
 */
export async function verifyDecimals(conn, quoteMint) {
  const k = String(quoteMint);
  if (verified.has(k)) return verified.get(k);
  const { quoteDecimalsOf } = await import('./meteora.mjs');
  const d = await quoteDecimalsOf(conn, k);
  if (Number.isInteger(d)) { verified.set(k, d); return d; }
  return null;
}

/** Test seam: pose a mint's decimals as already verified. */
export const __noteDecimals = (quoteMint, dec) => verified.set(String(quoteMint), dec);

/**
 * Credit one recorded claim into the launch's buckets.
 *
 * Runs inside a single database transaction with the `split_at` stamp, so the credit and the "this
 * one is done" marker cannot come apart: either both land or neither does, and a crash mid-way
 * replays cleanly.
 */
export function applySplit(claim, decimalsOverride = null) {
  const t = db.prepare('SELECT * FROM tokens WHERE mint=?').get(claim.mint);
  if (!t) { warn('fees', 'claim for an unknown mint', claim.mint); return null; }
  // ⛔ THE DECIMALS COME FROM THE CHAIN, NOT FROM A TABLE A HUMAN MAINTAINS.
  //
  // This was hardcoded to 6 once — right for REX and USDC, wrong by 1000x for SOL. The fix read
  // `QUOTES[quote].decimals` instead, which only moved the mistake somewhere a human could still
  // make it: STONK sat at 6 in that table while its mint says 9, and STNKOG's buckets were credited
  // 786.27 STONK against the 0.802 that was actually claimed. 980x, no error, and the number looked
  // wonderful. The payout then asked the chain for 195x what the fee claimer held and reverted —
  // nine times, 48 dead transactions, every one paying a fee to accomplish nothing.
  //
  // A multiplier on money may not come from a value someone typed. `verifyDecimals` reads the mint
  // and caches it; if nothing has verified this quote, we REFUSE TO SPLIT rather than credit on a
  // guess. Refusing is safe: the claim stays in `unsplit()` and the next crank run finishes it. A
  // wrong credit is not safe, because the pot is what the distributor spends against.
  // The CLAIM's quote mint, not the token's: the row records the asset that was actually claimed at
  // the time it was claimed, which is the thing being divided here. The token's column is only a
  // fallback, for a claim recorded before that column existed.
  const quoteMint = claim.quote_mint || t.quote_mint;
  const chainDec = decimalsFor(quoteMint);
  const decimals = Number.isFinite(decimalsOverride) ? decimalsOverride : chainDec;
  if (!Number.isFinite(decimals)) {
    warn('fees', `${t.symbol || claim.mint.slice(0, 8)}: the ${t.quote} mint ${String(quoteMint).slice(0, 8)}`
      + ' has not had its decimals read'
      + ' from the chain, so this claim is left unsplit for the next run rather than credited on a guess');
    return null;
  }
  // Compare the table against the CHAIN, never against the override — an operator repairing bad
  // history passes a figure on purpose, and reporting it as what the chain says would be a lie.
  const tableDec = QUOTES[t.quote]?.decimals;
  if (Number.isFinite(tableDec) && Number.isFinite(chainDec) && tableDec !== chainDec) {
    warn('fees', `⛔ ${t.quote} is ${tableDec}dp in the quotes table and ${chainDec}dp on chain`
      + ' — the split uses the chain figure. Fix the table: every PRICE shown for it is wrong by'
      + ` ${10 ** Math.abs(tableDec - chainDec)}x.`);
  }
  const buckets = bucketsOf(t);
  const { parts, remainder } = splitClaim(claim.quote_amount, buckets);
  const ui = (n) => Number(n) / 10 ** decimals;

  return tx(() => {
    // Re-check inside the transaction: another worker may have split this between our read and here.
    const fresh = db.prepare('SELECT split_at FROM fee_claims WHERE sig=?').get(claim.sig);
    if (!fresh || fresh.split_at !== null) return null;

    db.prepare(`UPDATE tokens SET
        yield_pool   = yield_pool   + ?,
        vault_pot    = vault_pot    + ?,
        burn_pot     = burn_pot     + ?,
        buyback_pot  = buyback_pot  + ?,
        rex_pot      = rex_pot      + ?
      WHERE mint=?`)
      .run(ui(parts.holder || 0n), ui(parts.vault || 0n), ui(parts.burn || 0n),
           ui(parts.buyback || 0n), ui(parts.rex || 0n), claim.mint);

    // ⛔ The remainder goes in its OWN column. It used to overwrite `quote_amount`, which meant the
    // public ledger — the thing that exists BECAUSE the split is no longer on-chain — reported the
    // leftover dust instead of the amount claimed, understating every single claim. A ledger that
    // misstates the figure it exists to prove is worse than no ledger.
    db.prepare('UPDATE fee_claims SET split_at=?, remainder=? WHERE sig=?')
      .run(Date.now(), String(remainder), claim.sig);

    log('💰 fee', claim.mint.slice(0, 6), 'split',
      Object.entries(parts).map(([k, v]) => `${k}:${ui(v).toFixed(6)}`).join(' '),
      remainder > 0n ? `(dust ${ui(remainder)} carried)` : '');
    return { parts, remainder };
  });
}

/**
 * The public ledger: claimed versus distributed, per launch.
 *
 * This exists because the split stopped being on-chain. Anyone who wants to check that REX Chain
 * divided the money the way it said it would can read this and add it up themselves, which is the
 * nearest thing to the guarantee the program used to give for free.
 */
export function ledger(mint = null) {
  const where = mint ? 'WHERE mint=?' : '';
  const args = mint ? [mint] : [];
  const rows = db.prepare(`SELECT mint, pool, side, quote_amount, base_amount, quote_mint, claimed_at, split_at, sig, remainder
    FROM fee_claims ${where} ORDER BY claimed_at DESC LIMIT 200`).all(...args);
  const totals = db.prepare(`SELECT COUNT(*) n, SUM(split_at IS NULL) pending FROM fee_claims ${where}`).get(...args) || {};
  return {
    claims: rows,
    count: totals.n || 0,
    pending: totals.pending || 0,
    note: 'Fees are claimed from the Meteora pool and divided by the launch\'s own bucket settings. '
        + 'Every claim is listed with its transaction signature so the division can be checked independently.',
  };
}
