// ⛔ 307 PAYOUT ROWS, 85,301 OF VALUE, AND NOT ONE HAD EVER BEEN SENT.
//
// Elio, by voice note: "the computer says that it already paid but i didn't receive any rex on my
// wallet." He was right, and it was true of every coin on the site.
//
// runEpoch ALLOCATES a holder's reward, writes the payouts row and increments `yield_paid`.
// payHolder SENDS it — and nothing ever called payHolder. PAYOUT_AUTO ran the protocol waterfall
// only, and no screen in the product offered a holder a way to claim, so the rows accumulated
// while the coin page reported `yield_paid` as "Paid so far".
//
//   node tools/holder_payout_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-hp-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'hp.sqlite';
const CLAIMER = Keypair.generate();
process.env.FEE_CLAIMER_KEY = bs58.encode(CLAIMER.secretKey);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const addr = () => Keypair.generate().publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const PO = await import('../lib/payout.mjs');
const E = await import('../lib/engine.mjs');

const QM = addr(), MINT = addr();
db.prepare(`INSERT INTO tokens(mint,name,symbol,quote,quote_mint,status,venue,created_at,yield_paid)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(MINT, 'Hold', 'HOLD', 'REX', QM, 'live', 'dbc', Date.now(), 1000);
const W1 = addr(), W2 = addr(), W3 = addr();
const ins = db.prepare('INSERT INTO payouts(mint,wallet,amount,mult,epoch,ts) VALUES(?,?,?,1,1,?)');
ins.run(MINT, W1, 600, Date.now());
ins.run(MINT, W2, 300, Date.now());
ins.run(MINT, W3, 100, Date.now());

console.log('── ⛔ "PAID SO FAR" NOW MEANS WHAT THE CHAIN CONFIRMED');
{
  ok(E.holderSent(MINT) === 0, 'nothing confirmed yet, so nothing is reported as paid');
  ok(E.holderWaiting(MINT) === 1000, `and 1000 is reported as waiting to go out (${E.holderWaiting(MINT)})`);
  const t = db.prepare('SELECT yield_paid FROM tokens WHERE mint=?').get(MINT);
  ok(t.yield_paid === 1000, 'the allocation figure still exists — it is just no longer called "paid"');

  // Settle one row the way the chain settling it would.
  db.prepare("UPDATE payouts SET claim_sig='sig1', paid_at=? WHERE wallet=?").run(Date.now(), W1);
  ok(E.holderSent(MINT) === 600, `a confirmed row counts as paid (${E.holderSent(MINT)})`);
  ok(E.holderWaiting(MINT) === 400, `and stops counting as waiting (${E.holderWaiting(MINT)})`);

  // ⛔ A row that is RESERVED but not confirmed is neither paid nor waiting: the money is in
  // flight, and calling it either would double-count it the moment the other side lands.
  db.prepare("UPDATE payouts SET claim_sig='sig2' WHERE wallet=?").run(W2);
  ok(E.holderSent(MINT) === 600, 'a signed-but-unconfirmed row is NOT reported as paid');
  ok(E.holderWaiting(MINT) === 100, 'nor as waiting — it is in flight');
}

console.log('\n── every owed holder is paid, not just whoever asks');
{
  const totals = PO.holderTotals(MINT);
  ok(totals.paid === 600 && totals.waiting === 100, `holderTotals agrees (${totals.paid}/${totals.waiting})`);

  // A dry run must touch nothing.
  const before = db.prepare('SELECT COUNT(*) n FROM payouts WHERE claim_sig IS NULL').get().n;
  const dry = await PO.payAllHolders({ conn: {}, CH: {}, execute: false });
  ok(dry.wallets >= 1, `a dry run visits the wallets that are owed (${dry.wallets})`);
  ok(db.prepare('SELECT COUNT(*) n FROM payouts WHERE claim_sig IS NULL').get().n === before,
    '⛔ and reserves nothing');
}

console.log('\n── ⛔ IT PAYS THE BIGGEST FIRST, AND SAYS WHAT IS LEFT');
{
  const src = fs.readFileSync(new URL('../lib/payout.mjs', import.meta.url), 'utf8');
  const fn = /export async function payAllHolders[\s\S]*?\n\}/.exec(src)?.[0] || '';
  // ⛔ Biggest in DOLLARS. Ordering by the raw amount adds REX to SOL as though one of each were
  // the same thing, which left $15 of SOL rewards behind $3 of REX ones.
  ok(/sort\(\(a, b\) => b\.usd - a\.usd\)/.test(fn),
    'biggest first, valued in dollars — a pass cut short has still moved the money that matters');
  ok(/maxWallets/.test(fn) && /out\.remaining/.test(fn),
    'it is capped per pass and reports the tail rather than pretending it finished');
  ok(/claim_sig IS NULL/.test(fn), 'only unreserved rows — it cannot double-send one in flight');
  // ⛔ RESOLVED THE SAME WAY THE SENDER RESOLVES IT. This used to read `t.quote_mint IS NOT NULL`,
  // which was right while a payout was always denominated in its coin's quote. A basket coin pays
  // its holders in several assets, so a row now carries its own asset_mint — and keying the skip
  // on the coin's quote alone would drop a perfectly sendable DOGE row because the coin's REX
  // quote had not been indexed. The invariant is unchanged and stricter: skip what cannot be sent.
  ok(/COALESCE\(p\.asset_mint, t\.quote_mint\) IS NOT NULL/.test(fn),
    'and skips rows with no resolvable asset mint, which cannot be sent at all');
  ok(/if \(!signer\(\)\)/.test(fn), '⛔ and refuses outright with no key rather than reporting success');
}

console.log('\n── the automatic loop runs it');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf("PAYOUT_AUTO === '1'");
  const loop = srv.slice(i, i + 2200);
  ok(/payProtocol\(/.test(loop), 'the treasury distribution still runs');
  ok(/payAllHolders\(/.test(loop), '⛔ and now the holders do too — this loop paid the treasury and nobody else');
  ok(/catch \(e\) \{ autoHolders/.test(loop), 'a holder-payout failure does not stop the loop');
  ok(/autoHolders,/.test(srv), 'and the result is visible in /api/health');
}

console.log('\n── the coin page no longer reports unsent money as paid');
{
  const pg = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  ok(/t\.yieldOwed > 0 \? `\$\{fmtQ\(t\.yieldOwed/.test(pg), 'it shows what is still waiting to go out');
  ok(!/fmtUsd\(t\.yieldPaid \* usd\(\)\)<\/div><div class="hint">\$\{t\.yieldPayouts\}/.test(pg),
    'and the old "N payouts" line, counted from allocations, is gone');
}

console.log('\n── ⛔ BIGGEST IN DOLLARS, NOT IN RAW UNITS');
{
  // ORDER BY SUM(amount) adds REX to SOL as though one of each were the same thing. 15,674 REX
  // (worth $2.98) outranked 0.0736 SOL (worth $15.45), so every SOL-owed wallet fell outside the
  // per-pass cap and $15 of holder rewards sat unsent behind $3 of them.
  const src = fs.readFileSync(new URL('../lib/payout.mjs', import.meta.url), 'utf8');
  const fn = /export async function payAllHolders[\s\S]*?\n\}/.exec(src)?.[0] || '';
  ok(!/ORDER BY SUM\(p\.amount\) DESC/.test(fn), 'the raw-unit ordering is gone');
  ok(/usdOf\(r\.quote\)/.test(fn), 'each group is valued in dollars first');
  ok(/sort\(\(a, b\) => b\.usd - a\.usd\)/.test(fn), 'and the wallets are ranked by that');
  // ⛔ PER WALLET AND PER UNIT — and the unit is the ROW'S asset, not its coin's quote. Grouping
  // by t.quote alone was correct until a coin could pay a basket; now one coin can owe one wallet
  // DOGE and WIF at once, and summing those under the coin's quote would recreate the exact bug
  // this block exists for, one layer along.
  ok(/GROUP BY p\.wallet, COALESCE\(p\.asset, t\.quote\)/.test(fn),
    '⛔ grouped per wallet AND the row\'s own asset — two assets are two different units to value');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
