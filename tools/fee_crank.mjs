// The fee crank. Claims REX Chain's side of every Meteora pool fee and divides it into the buckets.
//
//   node tools/fee_crank.mjs              # plan only — reads chain, signs nothing
//   node tools/fee_crank.mjs --execute    # claim and split, needs FEE_CLAIMER_KEY
//   node tools/fee_crank.mjs --split-only # finish splitting claims that already landed
//
// This is the piece that replaced on-chain fee enforcement, so it is written to be interruptible at
// any point rather than to be fast. Order is the whole design:
//
//   read accrued  ->  claim on chain  ->  RECORD the signature  ->  split into buckets
//
// The record happens before the split and in its own transaction. A crash between them leaves a
// claim with no split — which the next run finishes, because `--split-only` and the normal run both
// drain `unsplit()` first. The reverse order would allow a split with no claim, which is money
// invented out of nothing, and no amount of retry logic makes that recoverable.
//
// It will not claim dust. Below FEE_CLAIM_MIN_USD the signature costs more than it collects, and a
// crank that fires every minute on a few cents is a crank that donates to validators.
import { Connection, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const EXECUTE = process.argv.includes('--execute');
const SPLIT_ONLY = process.argv.includes('--split-only');

const { cfg, log } = await import('../lib/config.mjs');
const MET = await import('../lib/meteora.mjs');
const FEES = await import('../lib/fees.mjs');
const { db } = await import('../lib/db.mjs');
const { usdOf } = await import('../lib/prices.mjs');

if (!/^https?:/.test(String(cfg.rpcUrl || '').split(',')[0].trim())) {
  // An operator tool that dies on a stack trace is an operator tool nobody trusts at 3am.
  console.error('No RPC configured. Set RPC_URL (a https:// endpoint, optionally a comma-separated list).');
  process.exit(1);
}
// ⛔ Use the shared connection, not a Connection built from the raw setting. RPC_URL may be a
// COMMA-SEPARATED LIST with a paid endpoint first, so passing it whole yields a malformed URL and
// every call fails — which showed up here as "pool unreadable" on pools that were perfectly fine.
// The shared one also carries the failover, which a standalone tool wants even more than the server.
const CH = await import('../lib/chain.mjs');
const conn = CH.conn();
const key = cfg.feeClaimerKey;
const signer = key ? Keypair.fromSecretKey(bs58.decode(key)) : null;
if (EXECUTE && !signer && !SPLIT_ONLY) {
  console.error('--execute needs FEE_CLAIMER_KEY (base58 secret of the fee claimer wallet).');
  process.exit(1);
}

const ui = (n, d = 6) => Number(n) / 10 ** d;
console.log(`REX fee crank — ${EXECUTE ? 'EXECUTE' : 'plan only, nothing will be signed'}`);
if (signer) console.log(`fee claimer ${signer.publicKey.toBase58()}`);
console.log();

// ---------------------------------------------------------------- 1. finish anything half-done
// Always first. A claim that landed but was never divided is money sitting in a wallet that the
// buckets have not been told about, and it must be resolved before any new claim is made.
const pending = FEES.unsplit();
if (pending.length) {
  console.log(`RESUMING ${pending.length} claim(s) that landed but were never split`);
  for (const c of pending) {
    if (!EXECUTE && !SPLIT_ONLY) { console.log(`  ${c.mint.slice(0, 8)} ${ui(c.quote_amount)} — would split`); continue; }
    await FEES.verifyDecimals(conn, c.quote_mint);
    const r = FEES.applySplit(c);
    console.log(`  ${c.mint.slice(0, 8)} ${r ? 'split ✅' : 'already split by another run'}`);
  }
  console.log();
}
if (SPLIT_ONLY) { console.log('--split-only: done.'); process.exit(0); }

// ---------------------------------------------------------------- 2. what has accrued
const launches = db.prepare("SELECT mint, symbol, dbc_pool, quote, quote_mint, holder_bps, vault_bps, burn_bps, buyback_bps FROM tokens WHERE venue='dbc' AND dbc_pool IS NOT NULL").all();
if (!launches.length) {
  console.log('No Meteora launches yet — nothing to claim.');
  process.exit(0);
}
console.log(`Meteora launches: ${launches.length}`);

let claimable = 0;
for (const l of launches) {
  const f = await MET.feesOf(conn, l.dbc_pool).catch(() => null);
  if (!f) { console.log(`  ${String(l.symbol).padEnd(10)} pool unreadable`); continue; }
  if (f.partnerQuote === 0n && f.partnerBase === 0n) {
    console.log(`  ${String(l.symbol).padEnd(10)} nothing accrued`);
    continue;
  }
  const usd = ui(f.partnerQuote) * (usdOf(l.quote) || 0);
  const buckets = FEES.bucketsOf(l);
  const { parts, remainder } = FEES.splitClaim(f.partnerQuote, buckets);

  console.log(`\n  ${String(l.symbol).padEnd(10)} pool ${l.dbc_pool.slice(0, 8)}…`);
  console.log(`    accrued   ${ui(f.partnerQuote).toFixed(6)} ${l.quote}  (~$${usd.toFixed(2)})`);
  console.log(`    would go  ` + Object.entries(parts).map(([k, v]) => `${k} ${ui(v).toFixed(6)}`).join(' · '));
  if (remainder > 0n) console.log(`    dust      ${ui(remainder)} carried to the next run`);

  if (usd < cfg.feeClaimMinUsd) {
    console.log(`    SKIPPED — under the $${cfg.feeClaimMinUsd} floor; the signature would cost more than it collects.`);
    continue;
  }
  claimable++;
  if (!EXECUTE) continue;

  try {
    const tx = await MET.buildClaimPartnerFee({
      conn, feeClaimer: signer.publicKey.toBase58(), pool: l.dbc_pool,
      // Caps, not amounts: one more trade between the read above and this signature would make an
      // exact figure fail, so the program is told to pay out whatever is actually there.
      maxBase: f.partnerBase, maxQuote: f.partnerQuote,
    });
    const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });

    // Recorded BEFORE the split, in its own write. This ordering is the whole safety property.
    FEES.recordClaim({
      sig, mint: l.mint, pool: l.dbc_pool, side: 'partner',
      quoteAmount: f.partnerQuote, baseAmount: f.partnerBase, quoteMint: l.quote_mint,
    });
    console.log(`    ✅ claimed  ${sig.slice(0, 16)}…`);

    await FEES.verifyDecimals(conn, l.quote_mint);
    const r = FEES.applySplit({ ...FEES.unsplit().find((x) => x.sig === sig) });
    console.log(`    ✅ split    ${r ? 'buckets credited' : 'already credited'}`);
  } catch (e) {
    console.log(`    ❌ failed — ${String(e.message).slice(0, 160)}`);
  }
}

console.log(`\n${claimable} pool(s) above the $${cfg.feeClaimMinUsd} floor.`);
if (!EXECUTE && claimable) console.log('Re-run with --execute and FEE_CLAIMER_KEY set to actually claim.');
