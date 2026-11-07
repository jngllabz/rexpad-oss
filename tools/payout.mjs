// Pay out what REX Chain has collected. DRY RUN unless --execute is given.
//
// ⛔ THIS MOVES REAL MONEY. Without --execute it reads the chain and the database, prints exactly
// what it would send and to whom, and signs nothing. That is the default on purpose: the protocol's
// own distribution is a deliberate act, not something a timer should do behind anyone's back.
//
//   node tools/payout.mjs                 # what would be sent, and to whom
//   node tools/payout.mjs --execute       # send it
//   node tools/payout.mjs --holder <wallet> [--execute]
//   node tools/payout.mjs --reconcile     # resolve anything signed but unconfirmed
//   node tools/payout.mjs --recredit      # put back income the paper settlement marked paid
import { cfg } from '../lib/config.mjs';
import * as CH from '../lib/chain.mjs';
import * as PO from '../lib/payout.mjs';
import { usdOf, refreshPrices } from '../lib/prices.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);
const execute = has('--execute');
const money = (n) => `$${Number(n).toFixed(2)}`;

if (!CH.enabled()) {
  // ⛔ ALMOST ALWAYS MEANS "RUN ME IN THE WRONG PLACE". The keys and the live database are on the
  // machine, not on a laptop — same as the fee crank, which is why tools/ ships inside the image.
  console.log(`on-chain mode is off here, so there is nothing to pay.

This reads the LIVE database and signs with the fee claimer, both of which exist only on the
deployed machine. Run it there:

  flyctl ssh console -a rexpad -C "sh -lc 'cd /app && node tools/payout.mjs'"

Add --execute to that same command to send.`);
  process.exit(0);
}
await refreshPrices().catch(() => {});
const conn = CH.conn();

if (has('--reconcile')) {
  const r = await PO.reconcile({ conn });
  console.log(`reconcile: ${r.open} open → ${r.settled} settled, ${r.restored} restored`);
  process.exit(0);
}

if (!PO.canPay()) {
  console.log('⛔ FEE_CLAIMER_KEY is not set or is not a usable key — nothing can be sent.');
  if (execute) process.exit(1);
}

const holder = arg('--holder');
if (holder) {
  const due = PO.holderDue(holder);
  if (!due.length) { console.log(`${holder} is owed nothing.`); process.exit(0); }
  for (const g of due) console.log(`  ${g.total.toFixed(6)} ${g.quote}  (${money(g.total * (usdOf(g.quote) || 0))}) over ${g.rows.length} payout row(s)`);
  if (!execute) { console.log('\n(dry run — pass --execute to send)'); process.exit(0); }
  const r = await PO.payHolder({ conn, CH, wallet: holder, execute: true });
  console.log(`sent ${r.sent}, failed ${r.failed}, under the dust floor ${r.skipped}`);
  process.exit(r.failed ? 1 : 0);
}

if (has('--recredit')) {
  // ⛔ A LEDGER CORRECTION, NOT A TRANSFER. Puts back protocol income that the engine's paper
  // settlement marked as paid while the tokens never moved. Only touches amounts with no send on
  // the record, so it can never resurrect something that really was paid out.
  const r = PO.recreditUnsent({ execute });
  console.log(`\nProtocol income marked paid but never sent:`);
  for (const it of r.items) console.log(`  ${String(it.symbol || it.mint.slice(0, 6)).padEnd(10)} ${it.unsent.toFixed(6)}  (rex_paid ${it.rexPaid.toFixed(6)}, actually sent ${it.sent.toFixed(6)})`);
  console.log(`  total ${r.total.toFixed(6)}`);
  console.log(execute ? '\n↩️  recredited — run without --recredit to see what would now be sent'
                      : '\n(dry run — pass --execute with --recredit to apply)');
  process.exit(0);
}

const wfRes = await CH.waterfall();          // { legs, totalBps, authority, paused } — not an array
const wf = (wfRes?.legs || []).map((l) => ({ ...l, wallet: l.wallet?.toBase58?.() ?? String(l.wallet) }));
console.log('\nWaterfall, as the CHAIN states it:');
if (!wf.length) console.log('  ⛔ none — the config names no legs, so nothing can be split');
else for (const l of wf) console.log(`  ${String(l.label).padEnd(14)} ${String(l.bps).padStart(5)} bps  ${l.wallet}`);

const due = PO.protocolDue();
console.log('\nUnpaid protocol income (rex_pot), by asset:');
if (!due.length) console.log('  nothing owed');
for (const g of due) {
  console.log(`  ${g.total.toFixed(6)} ${g.quote}  (${money(g.total * (usdOf(g.quote) || 0))}) from ${g.items.length} launch(es)`);
  for (const it of g.items) console.log(`      ${String(it.symbol || it.mint.slice(0, 6)).padEnd(10)} ${it.amount.toFixed(6)}`);
}

// ⛔ THE PLAN IS PRINTED BEFORE ANYTHING IS SENT. payProtocol transfers inside its own loop, so a
// single call printed its table AFTER the money had already moved — under a heading that read
// "Would send: (SENDING)", which is both backwards and self-contradicting on a tool whose whole
// job is to be read before a transfer. A dry pass first costs one database read and nothing on
// chain, and means the operator sees exactly what is about to happen while it still matters.
const plan = await PO.payProtocol({ conn, CH, execute: false });
if (plan.error) { console.log(`\n⛔ ${plan.error}`); process.exit(1); }
console.log(execute ? '\nSending:' : '\nWould send: (dry run)');
for (const q of plan.legs) {
  console.log(`  ${q.quote}: ${q.total.toFixed(6)} (${money(q.usd)})`);
  for (const l of q.legs) console.log(`      ${String(l.label).padEnd(14)} ${l.amountRaw.padStart(18)} raw  -> ${l.dest}`);
}
if (!execute) { console.log('\n(dry run — pass --execute to send)'); process.exit(0); }
if (!plan.legs.length) { console.log('\nnothing to send'); process.exit(0); }

const r = await PO.payProtocol({ conn, CH, execute: true });
console.log(`\nsent ${r.sent}, failed ${r.failed}, under the dust floor ${r.skipped}`);
for (const s of r.sigs) console.log(`  ${s.ok ? '✅' : '⛔'} ${s.quote.padEnd(6)} ${s.sig}${s.error ? '  ' + s.error : ''}`);
if (r.failed) { console.log('\nA failed leg put its amounts back — nothing was deducted for it. Safe to re-run.'); process.exit(1); }
