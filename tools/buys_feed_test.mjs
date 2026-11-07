// The recent-buys feed: does it carry only buys, in the right order, with a truthful "new holder"?
//
// ⛔ THE FLAG IS THE WHOLE REASON THE FEED IS NOT JUST THE TAPE. Size and ticker are already on the
// page three other ways; "this wallet had never held this coin before" is the one fact a reader
// cannot get anywhere else, and it is also the only one here that can be quietly wrong — a
// first-buy test that counts every buy a wallet ever made looks correct until the DBC indexer
// backfills an older page of signatures and retroactively un-firsts a trade that has already been
// broadcast. So the count is bounded by the trade's own timestamp, and this file proves it by
// inserting the history out of order, which is how it genuinely arrives.
//
//   node tools/buys_feed_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-buys-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'buys.sqlite';

const { db } = await import('../lib/db.mjs');
const E = await import('../lib/engine.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const MINT = 'MintAAA', MINT2 = 'MintBBB', A = 'WalletA', B = 'WalletB';
db.prepare('INSERT INTO tokens(mint,name,symbol,image,quote,status,created_at,price) VALUES(?,?,?,?,?,?,?,?)')
  .run(MINT, 'Alpha', 'ALPHA', '', 'SOL', 'curve', 1000, 1);
db.prepare('INSERT INTO tokens(mint,name,symbol,image,quote,status,created_at,price) VALUES(?,?,?,?,?,?,?,?)')
  .run(MINT2, 'Beta', 'BETA', '', 'REX', 'curve', 1000, 1);

const ins = db.prepare('INSERT INTO trades(mint,wallet,side,quote,tokens,price,fee,tax,kind,ts) VALUES(?,?,?,?,?,?,0,0,?,?)');
// Deliberately NOT in timestamp order, the way a backfill arrives.
ins.run(MINT, A, 'buy', 2, 100, 0.02, 'curve', 5000);   // A's second buy, seen first
ins.run(MINT, A, 'buy', 1, 60, 0.016, 'curve', 3000);   // A's real first, arrives later
ins.run(MINT, B, 'sell', 9, 400, 0.022, 'curve', 6000); // must never appear
ins.run(MINT2, B, 'buy', 500, 20, 25, 'dbc', 7000);     // B's first ever, different coin
ins.run(MINT, A, 'buy', 0, 0, 0, 'curve', 8000);        // zero-size: not a buy anyone can read

const feed = E.recentBuys(20);

ok(feed.every((r) => r.quote > 0), 'no zero-size rows');
ok(!feed.some((r) => r.ts === 6000), 'the sell is absent');
ok(feed.length === 3, `three readable buys (got ${feed.length})`);
ok(feed.map((r) => r.ts).join(',') === '7000,5000,3000', `newest first (${feed.map((r) => r.ts).join(',')})`);

const byTs = Object.fromEntries(feed.map((r) => [r.ts, r]));
ok(byTs[3000]?.firstBuy === true, "A's earliest buy is flagged first");
ok(byTs[5000]?.firstBuy === false, "A's later buy is NOT flagged, even though it was inserted first");
ok(byTs[7000]?.firstBuy === true, 'a first buy on a second coin is flagged — the flag is per coin, not per wallet');
ok(byTs[7000]?.symbol === 'BETA' && byTs[7000]?.quoteSymbol === 'REX', 'the token and its quote asset come through');

// The same question the broadcast path asks, which must agree with the batch query or a row will
// change its badge the moment the page is reloaded.
ok(E.isFirstBuy(MINT, A, 3000) === true && E.isFirstBuy(MINT, A, 5000) === false,
  'isFirstBuy agrees with the feed at both timestamps');
ok(E.isFirstBuy(MINT, 'NeverTraded', 9000) === true, 'a wallet with no history reads as a first buy');
ok(E.isFirstBuy(null, A, 1) === false, 'a missing mint is not a first buy');

// `min` is a USD filter, and USD needs a quote price. With no price feed in a test process every
// quote is worth 0, so the only honest assertion is that a positive floor empties the feed rather
// than letting unpriced rows through as though they were free.
ok(E.recentBuys(20, { minUsd: 1e9 }).length === 0, 'a floor above every row filters the feed to nothing');
ok(E.recentBuys(1).length === 1, 'limit is respected');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
