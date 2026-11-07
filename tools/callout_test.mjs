// Callouts — the public half of a mechanism whose money half already existed.
//
// ⛔ THE ONE INVARIANT WORTH DEFENDING: THE ENTRY PRICE IS FIXED AT THE MOMENT OF THE CALL AND
// NEVER MOVES. A caller's record is worth exactly as much as that guarantee. Everything else here
// — the multiple, the board, the ranking — is derived from it, so if it can drift, none of it means
// anything.
//
//   node tools/callout_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-co-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'co.sqlite';
process.env.CALLOUT_COOLDOWN_MS = '3600000';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { db } = await import('../lib/db.mjs');
const E = await import('../lib/engine.mjs');
const C = await import('../lib/callouts.mjs');
const P = await import('../lib/points.mjs');

const A = 'CallerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'CallerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MINT = 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
for (const w of [A, B]) E.ensureWallet(w);

const seedCoin = (mint, price) => db.prepare(`INSERT OR REPLACE INTO tokens(mint,symbol,name,creator,quote,quote_mint,venue,price,status,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(mint, 'TST', 'Test Coin', A, 'SOL', 'So11111111111111111111111111111111111111112', 'dbc', price, 'live', Date.now());
const give = (w, mint, amt) => db.prepare('INSERT OR REPLACE INTO holdings(wallet,mint,amount,cost,realized,yield_earned,held_since) VALUES(?,?,?,0,0,0,?)').run(w, mint, amt, Date.now());

seedCoin(MINT, 0.000001);

console.log('── ⛔ A CALL HAS TO CARRY THE CALLER\'S OWN POSITION');
{
  const r = C.post(A, MINT, 'this one runs');
  ok(!r.ok && /Buy some/.test(r.error), `a wallet holding none of it is refused: "${r.error}"`);
  give(A, MINT, 1_000_000);
  const r2 = C.post(A, MINT, 'this one runs');
  ok(r2.ok && r2.priceAt === 0.000001, `with a position it posts, stamped at ${r2.priceAt}`);
}

console.log('\n── the entry is frozen, whatever the price does afterwards');
{
  const before = db.prepare('SELECT price_at, mcap_at FROM callouts WHERE wallet=?').get(A);
  db.prepare('UPDATE tokens SET price=? WHERE mint=?').run(0.000004, MINT);   // 4x
  const after = db.prepare('SELECT price_at, mcap_at FROM callouts WHERE wallet=?').get(A);
  ok(after.price_at === before.price_at, `price_at is still ${after.price_at} after the coin 4x'd`);
  ok(after.mcap_at === before.mcap_at, 'and so is the market cap it was called at');
}

console.log('\n── ⛔ NO DATA MEANS NO MULTIPLE, NEVER "1.00x"');
{
  const [c] = C.feed({ mint: MINT });
  ok(c.peakX === null, 'with no candles recorded since the call, peakX is null rather than a flat 1.00x');
  ok(c.nowX === 4, `nowX reads the live price (${c.nowX}x)`);
}

console.log('\n── the peak comes from the candles, and it is the PEAK, not the last price');
{
  const t0 = db.prepare('SELECT ts FROM callouts WHERE wallet=?').get(A).ts;
  const ins = db.prepare('INSERT OR REPLACE INTO candles(mint,ts,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,0,0)');
  ins.run(MINT, t0 + 60_000, 0.000001, 0.000009, 0.000001, 0.000002);   // spiked to 9x then fell back
  ins.run(MINT, t0 + 120_000, 0.000002, 0.000004, 0.000002, 0.000004);
  const [c] = C.feed({ mint: MINT });
  ok(Math.abs(c.peakX - 9) < 1e-9, `peakX is 9.00x — the high, not the 4.00x it settled at (${c.peakX})`);
}

console.log('\n── a candle from BEFORE the call cannot flatter it');
{
  const t0 = db.prepare('SELECT ts FROM callouts WHERE wallet=?').get(A).ts;
  db.prepare('INSERT OR REPLACE INTO candles(mint,ts,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,0,0)')
    .run(MINT, t0 - 60_000, 0.000001, 0.000099, 0.000001, 0.000001);   // a 99x spike before the call
  const [c] = C.feed({ mint: MINT });
  ok(Math.abs(c.peakX - 9) < 1e-9, `still 9.00x — the earlier 99x spike is not the caller's (${c.peakX})`);
}

console.log('\n── one call per coin per cooldown');
{
  const r = C.post(A, MINT, 'again');
  ok(!r.ok && /call it again in/.test(r.error), `a second call inside the window is refused: "${r.error}"`);
  ok(db.prepare('SELECT COUNT(*) n FROM callouts WHERE wallet=?').get(A).n === 1, 'and no row was written');
}

console.log('\n── ⛔ RANKED BY THE MEDIAN, SO SPRAYING DOES NOT WORK');
{
  // B makes five calls: four flat, one enormous. A has made one, at 9x.
  const mints = [];
  for (let i = 0; i < 5; i++) {
    const m2 = 'Spray' + String(i).repeat(39);
    mints.push(m2); seedCoin(m2, 0.000001); give(B, m2, 1000);
    const r = C.post(B, m2, 'spray ' + i);
    const big = i === 4;
    db.prepare('INSERT OR REPLACE INTO candles(mint,ts,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,0,0)')
      .run(m2, r.ts + 1000, 0.000001, big ? 0.00004 : 0.000001, 0.000001, 0.000001);  // one 40x, four 1x
  }
  const board = C.board();
  const a = board.find((x) => x.wallet === A), b = board.find((x) => x.wallet === B);
  ok(Math.abs(b.bestX - 40) < 1e-6, `B's best call is ${b.bestX.toFixed(0)}x — bigger than anything A has`);
  ok(Math.abs(b.medianX - 1) < 1e-6, `but B's median is ${b.medianX.toFixed(2)}x`);
  ok(Math.abs(a.medianX - 9) < 1e-6, `and A's is ${a.medianX.toFixed(2)}x`);
  ok(board[0].wallet === A, 'so A ranks first — the median beat the louder record');
}

console.log('\n── a caller with nothing measurable sorts below one with a record');
{
  const m3 = 'Fresh' + 'F'.repeat(39);
  seedCoin(m3, 0.000001); give(B, m3, 1000);
  C.post(B, m3, 'brand new, nothing recorded yet');
  const board = C.board();
  ok(board[0].wallet === A, 'an unmeasured call did not vault anyone to the top');
}

console.log('\n── points, derived like everything else');
{
  ok(P.actionPoints(A).callouts === P.RATES.callout, `one call is worth ${P.RATES.callout}`);
  ok(P.actionPoints(B).callouts === 6 * P.RATES.callout, 'six calls are worth six times that');
  db.prepare('DELETE FROM callouts WHERE wallet=?').run(B);
  ok(P.actionPoints(B).callouts === 0, 'and removing them takes the points with them, with nobody subtracting anything');
}

console.log('\n── a coin that does not exist, or has no price, cannot be called');
{
  ok(!C.post(A, 'NoSuchMint' + 'N'.repeat(34), 'x').ok, 'unknown mint refused');
  const m4 = 'Priceless' + 'P'.repeat(35);
  seedCoin(m4, 0); give(A, m4, 10);
  const r = C.post(A, m4, 'x');
  ok(!r.ok && /no price/.test(r.error), `a coin with no price refused: "${r.error}"`);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
