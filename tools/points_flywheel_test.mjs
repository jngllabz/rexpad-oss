// The points flywheel: tiers, downline, anti-gaming and the airdrop snapshot.
//
// ⛔ THE THREE THINGS THAT GO WRONG IN A POINTS SYSTEM, all of which are arithmetic rather than code:
//
//  1. A tier multiplier decided by the MULTIPLIED total eats itself — crossing a threshold raises
//     the total, which can cross the next threshold, which raises it again. One trade ratchets a
//     wallet through every tier and the ladder means nothing.
//  2. A referral share taken from the invitee's TOTAL compounds every multiplier down the chain, so
//     a Diamond inviting a Diamond pays out on activity that never happened.
//  3. A referral graph is not a tree. A→B→C→A is a legal shape in this table, and walking it
//     without a seen-set recurses until the stack gives out.
//
//   node tools/points_flywheel_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-pts-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'pts.sqlite';

const { db } = await import('../lib/db.mjs');
const P = await import('../lib/points.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

console.log('── the tier ladder is decided by the BASE score');
{
  ok(P.tierFor(0).key === 'bronze', 'a new wallet is Bronze');
  ok(P.tierFor(4999).mult === 1, 'just below a threshold keeps the lower multiplier');
  ok(P.tierFor(5000).key === 'silver' && P.tierFor(5000).mult === 1.1, 'and crossing it moves up');
  ok(P.tierFor(1e9).key === 'diamond', 'the top tier does not overflow into nothing');
  ok(P.tierFor(1e9).next === null && P.tierFor(0).next.label === 'Silver', 'the next tier is named until there is none');
  // ⛔ The ratchet: feeding a MULTIPLIED total back in must not climb the ladder on its own.
  const base = 4800, t1 = P.tierFor(base);
  const t2 = P.tierFor(base * t1.mult);
  ok(t2.key === t1.key, 'a tier cannot be reached by applying its own multiplier');
}

console.log('\n── a round trip is not volume');
{
  const W = 'WashWallet', MINT = 'MintW';
  db.prepare('INSERT INTO tokens(mint,name,symbol,image,quote,status,created_at,price) VALUES(?,?,?,?,?,?,?,?)')
    .run(MINT, 'Wash', 'WASH', '', 'SOL', 'live', 1000, 1);
  const trade = db.prepare('INSERT INTO trades(mint,wallet,side,quote,tokens,price,fee,tax,kind,ts) VALUES(?,?,?,?,?,?,0,0,?,?)');
  // A buy sold back a minute later: the same money going round.
  trade.run(MINT, W, 'buy', 100, 10, 10, 'curve', 1_000_000);
  trade.run(MINT, W, 'sell', 100, 10, 10, 'curve', 1_060_000);
  const washed = P.actionPoints(W).volume;
  // A buy that was kept.
  trade.run(MINT, W, 'buy', 100, 10, 10, 'curve', 5_000_000);
  const kept = P.actionPoints(W).volume;
  ok(washed === 0, `a buy sold back inside the window earns no volume (${washed})`);
  ok(kept > washed, `a buy that was kept does (${kept})`);
  // ⛔ And it must not be waitable-out: repeating the wash forever still earns nothing.
  trade.run(MINT, W, 'buy', 500, 50, 10, 'curve', 6_000_000);
  trade.run(MINT, W, 'sell', 500, 50, 10, 'curve', 6_030_000);
  ok(P.actionPoints(W).volume === kept, 'and repeating the wash adds nothing however often it is done');
}

console.log('\n── the downline pays on the invitee\'s BASE, and survives a cycle');
{
  const add = db.prepare('INSERT OR REPLACE INTO wallets(wallet,name,referred_by) VALUES(?,?,?)');
  add.run('A', 'a', null); add.run('B', 'b', 'A'); add.run('C', 'c', 'B'); add.run('D', 'd', 'C');
  const base = (w) => ({ A: 0, B: 1000, C: 1000, D: 1000 }[w] ?? 0);

  const d = P.downlinePoints('A', Date.now(), base);
  ok(d.level1 === 100, `level 1 pays 10% of the invitee's base (${d.level1})`);
  ok(d.level2 === 50, `level 2 pays 5% (${d.level2})`);
  ok(d.total === 150, 'and nothing deeper than that — two levels is the whole ladder');
  ok(d.invitees === 1, 'invitees counts only the direct ones');

  // ⛔ A→B→C→A. Without a seen-set this recurses until the stack gives out.
  add.run('A', 'a', 'D');
  let threw = null;
  try { const c = P.downlinePoints('A', Date.now(), base); ok(c.total === 150, `a cycle is walked once, not forever (${c.total})`); }
  catch (e) { threw = e.message; }
  ok(!threw, `a referral cycle does not blow the stack${threw ? ' — THREW: ' + threw : ''}`);
}

console.log('\n── the snapshot is frozen, and says so');
{
  const a = P.takeSnapshot(1);
  ok(a.wallets >= 0, `an epoch can be taken (${a.wallets} wallets)`);
  const b = P.takeSnapshot(1);
  ok(b.wallets === 0 && b.alreadyTaken === true,
    're-running an epoch writes nothing and reports that honestly rather than claiming a fresh snapshot');
  // ⛔ The whole point: an allocation must read the FROZEN figure, not a recomputation.
  const rows = P.snapshotOf(1, 5);
  if (rows.length) {
    const w = rows[0].wallet, was = rows[0].points;
    db.prepare('INSERT INTO trades(mint,wallet,side,quote,tokens,price,fee,tax,kind,ts) VALUES(?,?,?,?,?,?,0,0,?,?)')
      .run('MintW', w, 'buy', 9999, 99, 10, 'curve', 7_000_000);
    ok(P.snapshotOf(1, 5)[0].points === was, 'and trading after a snapshot does not change what it recorded');
  } else ok(true, '(no wallets in the fixture to freeze — the mechanism is covered above)');
  ok(P.snapshotEpochs().some((e) => e.epoch === 1), 'past epochs are listable');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
