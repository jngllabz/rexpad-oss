// ⛔ PAYING THE SHARERS OUT OF THE CREATOR'S OWN CLAIM.
//
// Share & earn lets a launcher give away a slice of THEIR cut to whoever brings buyers. On Meteora
// the creator's fee is claimed straight to their wallet, so nothing stood between the pool and
// them — the site tracked who brought what and paid nobody.
//
// The payment now rides inside the creator's own claim transaction: either the creator receives
// their fee and the sharers receive their slice, or neither happens. This file is about the money
// maths, because an allocation that does not sum exactly is a slow leak out of somebody's pocket.
//
//   node tools/sharers_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-sh-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'sh.sqlite';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const addr = () => Keypair.generate().publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const SH = await import('../lib/sharers.mjs');

console.log('── ⛔ THE PARTS SUM TO EXACTLY THE POOL, ALWAYS');
{
  // Rounding each share independently strands dust that belongs to somebody, every single claim.
  let worst = 0n, runs = 0;
  for (let i = 0; i < 2000; i++) {
    const n = 1 + Math.floor(Math.random() * 7);
    const rows = Array.from({ length: n }, () => ({ referrer: addr(), volume: Math.random() * 1e6 }));
    const pool = BigInt(Math.floor(Math.random() * 1e12));
    const parts = SH.splitByVolume(rows, pool);
    const sum = parts.reduce((a, p) => a + p.amountRaw, 0n);
    const diff = pool > sum ? pool - sum : sum - pool;
    if (diff > worst) worst = diff;
    runs++;
  }
  ok(worst === 0n, `${runs} random splits, worst discrepancy ${worst} units`);
}

console.log('\n── it divides by volume, not by head count');
{
  const a = addr(), b = addr();
  const parts = SH.splitByVolume([{ referrer: a, volume: 75 }, { referrer: b, volume: 25 }], 1000n);
  const byW = Object.fromEntries(parts.map((p) => [p.referrer, p.amountRaw]));
  ok(byW[a] === 750n && byW[b] === 250n, `75/25 of the volume gets 75/25 of the pool (${byW[a]}/${byW[b]})`);
}

console.log('\n── nothing is invented out of nothing');
{
  ok(SH.splitByVolume([], 1000n).length === 0, 'no sharers, no parts');
  ok(SH.splitByVolume([{ referrer: addr(), volume: 0 }], 1000n).length === 0, '⛔ zero volume earns zero, not an equal share');
  ok(SH.splitByVolume([{ referrer: addr(), volume: 5 }], 0n).length === 0, 'an empty pool pays nobody');
  ok(SH.splitByVolume([{ referrer: addr(), volume: 5 }], -5n).length === 0, 'and a negative one cannot happen');
}

console.log('\n── the plan: a slice of THIS claim, on top of what was already owed');
{
  const MINT = addr(), s1 = addr(), s2 = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,quote,quote_mint,status,venue,created_at,ref_share_bps)
              VALUES(?,?,?,?,?,?,?,?,?,?)`).run(MINT, 'T', 'T', addr(), 'SOL', addr(), 'live', 'dbc', Date.now(), 2500);
  const ins = db.prepare('INSERT INTO ref_credit(mint,referrer,volume,owed) VALUES(?,?,?,?)');
  ins.run(MINT, s1, 300, 0);
  ins.run(MINT, s2, 100, 0);
  const token = db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT);

  // 1.0 SOL claimed, 25% shared = 0.25 SOL across 300/100 volume = 0.1875 / 0.0625
  const plan = SH.sharerPlan({ token, claimedRaw: 1_000_000_000, decimals: 9 });
  ok(plan.poolRaw === 250_000_000n, `25% of the claim is the pool (${plan.poolRaw})`);
  const got = Object.fromEntries(plan.accrue.map((a) => [a.referrer, Number(a.amountRaw)]));
  ok(got[s1] === 187_500_000 && got[s2] === 62_500_000, 'split by volume');
  ok(plan.pay.length === 2, 'both are payable');

  SH.accrueOwed(MINT, plan.accrue, 9);
  const owed = Object.fromEntries(db.prepare('SELECT referrer, owed FROM ref_credit WHERE mint=?').all(MINT).map((r) => [r.referrer, r.owed]));
  ok(Math.abs(owed[s1] - 0.1875) < 1e-9, `owed is recorded (${owed[s1]})`);

  // ⛔ A SECOND CLAIM ADDS TO THE BALANCE, it does not replace it.
  const plan2 = SH.sharerPlan({ token, claimedRaw: 1_000_000_000, decimals: 9 });
  const pay1 = plan2.pay.find((r) => r.referrer === s1);
  ok(Math.abs(pay1.owed - 0.375) < 1e-9, `the second claim pays the running balance (${pay1.owed})`);
}

console.log('\n── ⛔ A CLAIM IS ONLY SETTLED FROM WHAT THE CHAIN CONFIRMS');
{
  const MINT = addr(), s1 = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,quote,quote_mint,status,venue,created_at,ref_share_bps)
              VALUES(?,?,?,?,?,?,?,?,?,?)`).run(MINT, 'U', 'U', addr(), 'SOL', addr(), 'live', 'dbc', Date.now(), 5000);
  db.prepare('INSERT INTO ref_credit(mint,referrer,volume,owed) VALUES(?,?,?,?)').run(MINT, s1, 100, 2);

  // The wallet prompt was cancelled: nothing confirmed, so nothing is forgiven.
  SH.settlePaid(MINT, {});
  ok(db.prepare('SELECT owed FROM ref_credit WHERE mint=? AND referrer=?').get(MINT, s1).owed === 2,
    '⛔ a transaction that never landed leaves the debt exactly where it was');

  SH.settlePaid(MINT, { [s1]: 1.5 });
  const r = db.prepare('SELECT owed, paid FROM ref_credit WHERE mint=? AND referrer=?').get(MINT, s1);
  ok(Math.abs(r.owed - 0.5) < 1e-9 && Math.abs(r.paid - 1.5) < 1e-9, `a partial payment moves exactly that much (owed ${r.owed}, paid ${r.paid})`);
  ok(Math.abs(db.prepare('SELECT ref_paid FROM tokens WHERE mint=?').get(MINT).ref_paid - 1.5) < 1e-9,
    'and the coin\'s lifetime figure follows');

  SH.settlePaid(MINT, { [s1]: 99 });
  ok(db.prepare('SELECT owed FROM ref_credit WHERE mint=? AND referrer=?').get(MINT, s1).owed === 0,
    '⛔ and owed can never go negative, whatever arrives');
}

console.log('\n── share & earn off means nobody is paid anything');
{
  const MINT = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,quote,quote_mint,status,venue,created_at,ref_share_bps)
              VALUES(?,?,?,?,?,?,?,?,?,0)`).run(MINT, 'V', 'V', addr(), 'SOL', addr(), 'live', 'dbc', Date.now());
  db.prepare('INSERT INTO ref_credit(mint,referrer,volume,owed) VALUES(?,?,?,0)').run(MINT, addr(), 500);
  const token = db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT);
  const plan = SH.sharerPlan({ token, claimedRaw: 1_000_000_000, decimals: 9 });
  ok(plan.pay.length === 0 && plan.accrue.length === 0, 'a coin with it switched off pays nobody, however much volume was brought');
}

console.log('\n── a long tail is carried, not crammed into one transaction');
{
  const MINT = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,creator,quote,quote_mint,status,venue,created_at,ref_share_bps)
              VALUES(?,?,?,?,?,?,?,?,?,10000)`).run(MINT, 'W', 'W', addr(), 'SOL', addr(), 'live', 'dbc', Date.now());
  const ins = db.prepare('INSERT INTO ref_credit(mint,referrer,volume,owed) VALUES(?,?,?,0)');
  for (let i = 0; i < 20; i++) ins.run(MINT, addr(), 100 - i);
  const token = db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT);
  const plan = SH.sharerPlan({ token, claimedRaw: 1_000_000_000, decimals: 9 });
  ok(plan.pay.length === SH.MAX_SHARERS_PER_CLAIM, `only ${SH.MAX_SHARERS_PER_CLAIM} are paid in one claim`);
  ok(plan.carried > 0, `⛔ and the rest is carried rather than dropped (${plan.carried.toFixed(6)})`);
  ok(plan.accrue.length === 20, 'every one of them still accrues their share');
}

console.log('\n── the transfers go in the creator\'s own transaction, after the unwrap');
{
  const met = fs.readFileSync(new URL('../lib/meteora.mjs', import.meta.url), 'utf8');
  const fn = /async function shareTransfers[\s\S]*?\n\}/.exec(met)?.[0] || '';
  ok(/isNativeQuote\(quoteMint\)/.test(fn), 'native SOL is handled separately');
  ok(/SystemProgram\.transfer/.test(fn),
    '⛔ with a system transfer — the claim CLOSES the wrapper, so a token transfer would find an account that no longer exists');
  ok(/createAssociatedTokenAccountIdempotentInstruction/.test(fn), 'and a token quote opens the sharer\'s account');
  ok(/createTransferCheckedInstruction/.test(fn), 'then transfers with the decimals checked');
  ok(/\.\.\.suffix, \.\.\.share/.test(met), '⛔ appended AFTER the unwrap, not before it');
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  ok(/accrueOwed\(t\.mint, plan\.accrue, decq\)/.test(srv), 'owed goes up when the claim is built');
  ok(/SH\.settlePaid\(t\.mint, paidBy\)/.test(srv), '⛔ and only comes down from what the confirmed transaction actually moved');
  ok(/sharers: plan\.pay\.map/.test(srv), 'and the creator is shown who is being paid before they sign');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
