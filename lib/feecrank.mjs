// Claiming REX Chain's side of every Meteora pool fee, and dividing it into the buckets.
//
// This was a tool you ran by hand (`tools/fee_crank.mjs`). It is now a function, because a crank
// nobody runs is a crank that does not exist: $BITE sat on $245 of claimable fees while its reward
// panel read "$0", and the only reason was that no human had typed the command. The tool still
// exists for a dry run and for forcing a pass; both now call THIS, so there is one implementation
// of the money path rather than two that can drift apart.
//
// ⛔ THE ORDER IS THE WHOLE DESIGN, and it is unchanged from the tool:
//
//     read accrued  ->  claim on chain  ->  RECORD the signature  ->  split into buckets
//
// The record happens before the split and in its own write. A crash between them leaves a claim
// with no split, which the next pass finishes because every pass drains `unsplit()` first. The
// reverse order would allow a split with no claim — money invented out of nothing, and no amount of
// retry logic makes that recoverable.
//
// It will not claim dust: below `feeClaimMinUsd` the signature costs more than it collects, and a
// crank firing every few minutes on a few cents is a crank that donates to validators.
import { Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { cfg, log, warn } from './config.mjs';
import { db } from './db.mjs';
import { usdOf } from './prices.mjs';
import * as FEES from './fees.mjs';

export const hasClaimer = () => !!signerOf();

/** The signer, or null when no usable key is configured. Never logged, never returned to a caller. */
function signerOf() {
  if (!cfg.feeClaimerKey) return null;
  try { return Keypair.fromSecretKey(bs58.decode(cfg.feeClaimerKey)); }
  catch (e) { return null; }
}

/**
 * ⛔ A SECRET THAT IS SET BUT UNUSABLE IS WORSE THAN ONE THAT IS MISSING.
 * Missing, the server says so at startup and everyone knows where they stand. Set to a placeholder
 * — `<base58-secret-of-...>` pasted out of an example — it looks configured, `hasClaimer()` is true,
 * the crank schedules itself, and every pass quietly does nothing. The same mistake had already
 * been made with the RPC key, so it is checked the same way: once, loudly, at startup.
 *
 * Returns null when fine, or a sentence describing what is wrong. Never includes the value.
 */
export function claimerProblem() {
  const k = String(cfg.feeClaimerKey || '');
  if (!k) return 'FEE_CLAIMER_KEY is not set — fees will accrue on the pools and never be claimed or paid out.';
  if (/^<|>$|placeholder|your[_-]|secret-of/i.test(k)) {
    return 'FEE_CLAIMER_KEY is a PLACEHOLDER, not a key — paste the wallet\'s actual base58 secret. Nothing will be claimed until it is.';
  }
  const signer = signerOf();
  if (!signer) return `FEE_CLAIMER_KEY is ${k.length} characters and is not a valid base58 secret key (expected 87-88). Nothing will be claimed.`;
  // The key must belong to the wallet the pool configs name as fee claimer, or every claim reverts.
  if (cfg.feeClaimer && signer.publicKey.toBase58() !== cfg.feeClaimer) {
    return `FEE_CLAIMER_KEY is the key for ${signer.publicKey.toBase58().slice(0, 8)}… but FEE_CLAIMER names ${String(cfg.feeClaimer).slice(0, 8)}… — claims would be refused on chain.`;
  }
  return null;
}

/**
 * One pass. With `execute: false` it reads chain and signs nothing, which is what the dry run does.
 * Returns a plain summary so a caller can log or ignore it.
 */
export async function runOnce({ conn, execute = false, MET } = {}) {
  const out = { resumed: 0, claimed: 0, skipped: 0, accruedUsd: 0, failed: 0 };
  const signer = execute ? signerOf() : null;
  if (execute && !signer) return { ...out, error: 'no FEE_CLAIMER_KEY' };

  // 1. Finish anything half-done. Always first: a claim that landed but was never divided is money
  //    sitting in a wallet the buckets have not been told about, and it must be resolved before any
  //    new claim is made.
  for (const c of FEES.unsplit()) {
    if (!execute) { out.resumed++; continue; }
    try {
      // ⛔ READ THE DECIMALS OFF THE MINT FIRST. applySplit will not credit on a table value, and
      // a claim it refuses stays here for the next run — which is the right way round.
      await FEES.verifyDecimals(conn, c.quote_mint);
      if (FEES.applySplit(c)) out.resumed++;
    } catch (e) { warn('fee split', e.message); out.failed++; }
  }

  const launches = db.prepare(
    "SELECT mint, symbol, dbc_pool, quote, quote_mint, holder_bps, vault_bps, burn_bps, buyback_bps FROM tokens WHERE venue='dbc' AND dbc_pool IS NOT NULL",
  ).all();

  for (const l of launches) {
    const f = await MET.feesOf(conn, l.dbc_pool).catch(() => null);
    if (!f) continue;
    if (f.partnerQuote === 0n && f.partnerBase === 0n) continue;

    const dec = 6;
    const usd = (Number(f.partnerQuote) / 10 ** dec) * (usdOf(l.quote) || 0);
    out.accruedUsd += usd;

    // Under the floor the signature costs more than it collects.
    if (usd < cfg.feeClaimMinUsd) { out.skipped++; continue; }
    if (!execute) { out.claimed++; continue; }

    try {
      const tx = await MET.buildClaimPartnerFee({
        conn, feeClaimer: signer.publicKey.toBase58(), pool: l.dbc_pool,
        // Caps, not amounts: one more trade between the read above and this signature would make an
        // exact figure fail, so the program is told to pay out whatever is actually there.
        maxBase: f.partnerBase, maxQuote: f.partnerQuote,
      });
      const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });

      FEES.recordClaim({
        sig, mint: l.mint, pool: l.dbc_pool, side: 'partner',
        quoteAmount: f.partnerQuote, baseAmount: f.partnerBase, quoteMint: l.quote_mint,
      });
      const claim = FEES.unsplit().find((x) => x.sig === sig);
      if (claim) {
        await FEES.verifyDecimals(conn, l.quote_mint);
        FEES.applySplit(claim);
      }
      out.claimed++;
      log(`fee crank claimed ${l.symbol} ~$${usd.toFixed(2)} ${sig.slice(0, 16)}…`);
    } catch (e) {
      out.failed++;
      warn('fee crank', `${l.symbol}: ${String(e.message).slice(0, 160)}`);
    }
  }
  return out;
}
