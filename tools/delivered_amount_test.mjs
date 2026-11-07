// A payout is paid for what ARRIVED, not for what was sent.
//
// ⛔ WHAT WAS WRONG. `paid_at` was stamped on a confirmed signature and nothing else. A Token-2022
// transfer fee is deducted IN FLIGHT — the instruction moves 100, the recipient's balance rises by
// 97, and the transaction succeeds — so for GP, ZCAT and MASK (3%) and SI (1%) the ledger recorded
// a full payment that was never delivered. Every "paid" figure built on it was overstated, which
// is the same shape as "Paid so far" once counting allocations nothing had sent: Elio, 11 Oct,
// "the computer says that it already paid but i didn't receive any rex on my wallet."
//
// The read-back is from the transaction's own pre/post balances, so the fee is already taken out
// of the number by construction rather than modelled here — this file never hardcodes 3%.
//
//   node tools/delivered_amount_test.mjs
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-delivered-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'delivered.sqlite';
process.env.SIM = '1';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { db } = await import('../lib/db.mjs');
const PO = await import('../lib/payout.mjs');
const src = fs.readFileSync(new URL('../lib/payout.mjs', import.meta.url), 'utf8');

// ---------- the column and the two settle paths ----------
const cols = new Set(db.prepare('PRAGMA table_info(payouts)').all().map((c) => c.name));
ok(cols.has('delivered'), 'payouts carries a `delivered` column');

ok(/async function settleLanded/.test(src), 'there is one settle path, named');
// ⛔ BOTH LANDING ROUTES MUST USE IT. The happy path and the "timed out but didLand says yes" path
// both mark rows paid; if only one reads back, a timeout becomes the route that still records a
// fee-bearing transfer as paid in full.
const settleCalls = (src.match(/await settleLanded\(/g) || []).length;
ok(settleCalls >= 3, `every landing route settles through it (${settleCalls} call sites: send, post-timeout, reconcile)`);
ok(!/UPDATE payout_sends SET settled_at=\?, WHERE/.test(src), 'no stray half-settle left behind');

// The reconciler is the third route and the easiest to forget — a crash between signing and
// confirming would otherwise be the one way back to paid-in-full.
const rec = /export async function reconcile[\s\S]*?\n\}/.exec(src)?.[0] || '';
ok(/settleLanded/.test(rec), 'the reconciler settles the same way the sender does');

// ---------- reporting reads what landed ----------
ok(/COALESCE\(SUM\(CASE WHEN paid_at IS NOT NULL THEN COALESCE\(delivered, amount\) END\), 0\) AS paid/.test(src),
  '⛔ holderTotals reports what was DELIVERED, not what was asked for');
const eng = fs.readFileSync(new URL('../lib/engine.mjs', import.meta.url), 'utf8');
ok(/SUM\(COALESCE\(delivered, amount\)\)[\s\S]{0,80}paid_at IS NOT NULL/.test(eng),
  'and so does the per-coin paid total in engine.mjs');

// ⛔ COALESCE TO `amount`, NEVER TO 0. NULL means "settled before this column existed" or "could
// not read the transaction back". Treating that as zero delivered would erase every historical
// payout from the books overnight.
ok(!/COALESCE\(delivered, 0\)/.test(src) && !/COALESCE\(delivered, 0\)/.test(eng),
  '⛔ an unknown `delivered` falls back to `amount`, not to zero');

// ---------- the apportioning, on real numbers ----------
// One leg pays one wallet; several payout rows can sit behind it. The delivered total has to be
// split across them by their share of what was asked, or one row absorbs the whole fee.
{
  const W = 'Holder1111111111111111111111111111111111111';
  const SIG = 'SigAAA11111111111111111111111111111111111111';
  db.prepare("INSERT INTO tokens (mint,name,symbol,creator,quote,status) VALUES ('m1','A','A',?,'GP','live')").run(W);
  db.prepare("INSERT INTO tokens (mint,name,symbol,creator,quote,status) VALUES ('m2','B','B',?,'GP','live')").run(W);
  const ins = db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts,claim_sig) VALUES(?,?,?,1,0,0,?)');
  ins.run('m1', W, 75, SIG);
  ins.run('m2', W, 25, SIG);

  // 100 asked, 97 delivered — a 3% transfer fee, as GP actually charges.
  const rows = db.prepare('SELECT id, wallet, amount FROM payouts WHERE claim_sig=?').all(SIG);
  const askedByWallet = new Map();
  for (const r of rows) askedByWallet.set(r.wallet, (askedByWallet.get(r.wallet) || 0) + r.amount);
  const landed = 97;
  for (const r of rows) {
    const share = r.amount / askedByWallet.get(r.wallet);
    db.prepare('UPDATE payouts SET paid_at=?, delivered=? WHERE id=?').run(Date.now(), landed * share, r.id);
  }
  const out = db.prepare('SELECT amount, delivered FROM payouts WHERE claim_sig=? ORDER BY amount DESC').all(SIG);
  ok(Math.abs(out[0].delivered - 72.75) < 1e-9, `the 75 row is credited 72.75, not 75 (got ${out[0].delivered})`);
  ok(Math.abs(out[1].delivered - 24.25) < 1e-9, `the 25 row is credited 24.25, not 25 (got ${out[1].delivered})`);
  const sum = out.reduce((a, r) => a + r.delivered, 0);
  ok(Math.abs(sum - landed) < 1e-9, '⛔ the parts add up to exactly what arrived — the fee is not counted twice or lost');
  ok(out.every((r) => r.delivered < r.amount), 'every row records less than it asked for, which is the honest record');
}

// ---------- a fee-free asset is unchanged ----------
{
  const W = 'Holder2222222222222222222222222222222222222';
  const SIG = 'SigBBB22222222222222222222222222222222222222';
  db.prepare("INSERT INTO tokens (mint,name,symbol,creator,quote,status) VALUES ('m3','C','C',?,'SOL','live')").run(W);
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts,claim_sig) VALUES(?,?,?,1,0,0,?)').run('m3', W, 10, SIG);
  db.prepare('UPDATE payouts SET paid_at=?, delivered=? WHERE claim_sig=?').run(Date.now(), 10, SIG);
  const r = db.prepare('SELECT amount, delivered FROM payouts WHERE claim_sig=?').get(SIG);
  ok(r.delivered === r.amount, 'an asset with no transfer fee delivers exactly what it asked for');
}

// ---------- "could not read it back" is not "nothing arrived" ----------
{
  const W = 'Holder3333333333333333333333333333333333333';
  const SIG = 'SigCCC33333333333333333333333333333333333333';
  db.prepare("INSERT INTO tokens (mint,name,symbol,creator,quote,status) VALUES ('m4','D','D',?,'SOL','live')").run(W);
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts,claim_sig) VALUES(?,?,?,1,0,0,?)').run('m4', W, 40, SIG);
  db.prepare('UPDATE payouts SET paid_at=? WHERE claim_sig=?').run(Date.now(), SIG);   // the null-got branch
  const r = db.prepare('SELECT amount, delivered, paid_at FROM payouts WHERE claim_sig=?').get(SIG);
  ok(r.paid_at && r.delivered === null, 'an unreadable transaction leaves `delivered` NULL rather than 0');
  const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN COALESCE(delivered, amount) END),0) p
                             FROM payouts WHERE mint='m4'`).get().p;
  ok(totals === 40, '⛔ and it still counts as 40 in the books, not as 0');
}

// `deliveredByDest` must distinguish those two outcomes at the source, which is the whole reason
// the caller can.
const fn = /async function deliveredByDest[\s\S]*?\n\}/.exec(src)?.[0] || '';
ok(/return null/.test(fn), 'deliveredByDest returns null when it cannot read the transaction');
ok(/preTokenBalances/.test(fn) && /postTokenBalances/.test(fn), 'it reads SPL/Token-2022 deltas off the transaction');
ok(/preBalances/.test(fn) && /postBalances/.test(fn), 'and native SOL by lamport delta');
ok(/isNative\(quoteMint\)/.test(fn), '⛔ native SOL takes the lamport path — it has no token balances to read');


// ---------- a BASKET leg settles against the ROW'S asset, not the coin's quote ----------
//
// ⛔ THIS PATH HAS NO MAINNET MILEAGE. Zero coins in production carry a payout basket, so a leg
// whose asset differs from its coin's quote has never settled for real. The failure it guards is
// quiet: resolving the coin's quote instead of the row's asset reads the wrong mint's balance
// delta and divides by the wrong decimals, and the result is a plausible-looking number rather
// than a crash. The transaction below deliberately contains BOTH assets, so a settle that picked
// the wrong one would find something and succeed.
{
  const W = 'Holder4444444444444444444444444444444444444';
  const SIG = 'SigDDD44444444444444444444444444444444444444';
  const DOGE = 'DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R';   // 8dp, the basket leg
  const REX  = 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump';   // 6dp, the coin's quote
  db.prepare("INSERT INTO tokens (mint,name,symbol,creator,quote,quote_mint,status) VALUES ('m5','E','E',?,'REX',?,'live')").run(W, REX);
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts,claim_sig,asset,asset_mint) VALUES(?,?,?,1,0,0,?,?,?)')
    .run('m5', W, 100, SIG, 'DOGE', DOGE);

  // A stub connection returning one transaction carrying a delta in BOTH mints. 97 DOGE arrived
  // (a 3% fee on 100); the REX figure is a decoy at a different scale and different decimals.
  const conn = {
    getTransaction: async () => ({
      meta: {
        preTokenBalances: [
          { mint: DOGE, owner: W, uiTokenAmount: { amount: '0' } },
          { mint: REX,  owner: W, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { mint: DOGE, owner: W, uiTokenAmount: { amount: '9700000000' } },   // 97 at 8dp
          { mint: REX,  owner: W, uiTokenAmount: { amount: '5000000' } },      //  5 at 6dp — decoy
        ],
      },
    }),
  };
  await PO.__settleLandedForTest(conn, SIG, DOGE, 8);
  const r = db.prepare('SELECT amount, delivered, paid_at FROM payouts WHERE claim_sig=?').get(SIG);
  ok(Math.abs(r.delivered - 97) < 1e-6, `the DOGE leg is credited 97, from DOGE's own delta at 8dp (got ${r.delivered})`);
  ok(r.delivered !== 5, '⛔ it did NOT read the coin\'s REX quote, which was sitting in the same transaction');
  ok(r.paid_at > 0, 'and the row is marked paid');
}

// The same transaction settled against the WRONG mint must produce a different answer — otherwise
// the assertion above would hold even if the filter did nothing.
{
  const W = 'Holder5555555555555555555555555555555555555';
  const SIG = 'SigEEE55555555555555555555555555555555555555';
  const DOGE = 'DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R';
  const REX  = 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump';
  db.prepare("INSERT INTO tokens (mint,name,symbol,creator,quote,quote_mint,status) VALUES ('m6','F','F',?,'REX',?,'live')").run(W, REX);
  db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts,claim_sig,asset,asset_mint) VALUES(?,?,?,1,0,0,?,?,?)')
    .run('m6', W, 100, SIG, 'DOGE', DOGE);
  const conn = {
    getTransaction: async () => ({
      meta: {
        preTokenBalances: [{ mint: DOGE, owner: W, uiTokenAmount: { amount: '0' } }, { mint: REX, owner: W, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [
          { mint: DOGE, owner: W, uiTokenAmount: { amount: '9700000000' } },
          { mint: REX,  owner: W, uiTokenAmount: { amount: '5000000' } },
        ],
      },
    }),
  };
  await PO.__settleLandedForTest(conn, SIG, REX, 6);     // deliberately the coin's quote
  const r = db.prepare('SELECT delivered FROM payouts WHERE claim_sig=?').get(SIG);
  ok(Math.abs(r.delivered - 5) < 1e-6,
    `⛔ settling against the wrong mint really does give a different, wrong answer (${r.delivered}) — so the check above is testing the filter, not passing by luck`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
