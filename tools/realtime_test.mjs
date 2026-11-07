// Does a Meteora swap reach the OPEN PAGES, or only the database?
//
// ⛔ THIS IS THE BUG THIS FILE EXISTS FOR, AND IT WAS INVISIBLE TO EVERY OTHER TEST. Every live
// board on the site redraws from the engine's event queue, which the server drains every 200ms and
// broadcasts over the WebSocket. That queue is written by our own curve's buy/sell — which a
// Meteora swap never passes through. So the indexer stored trades, wrote candles and moved prices,
// and told nobody: the pairs board, the leaderboard and the tape all sat frozen on whatever was
// true when the tab loaded, and the only way to see a new price was to reload. The database was
// right the whole time, which is why "the data is correct but stale" was the exact symptom.
//
// It cannot be verified against production by watching, either. A board that does not change
// because nothing traded looks identical to a board that does not change because it is broken, and
// a 50-second window on a quiet coin proves neither. So the swap is synthesised here: a real
// `indexPool` pass over a stub RPC, asserting the event comes out the far end.
//
//   node tools/realtime_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

// An isolated database, so a test that writes trades can never touch the real one.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-rt-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'rt.sqlite';

const { db } = await import('../lib/db.mjs');
const ENG = await import('../lib/engine.mjs');
const { indexPool } = await import('../lib/dbcindex.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// Real keypairs, because `new PublicKey` is given these for the signature walk and a hand-typed
// base58-looking string is not a valid 32-byte key.
const addr = () => Keypair.generate().publicKey.toBase58();
const POOL = addr(), BASE_V = addr(), QUOTE_V = addr(), TRADER = addr(), MINT = addr();

db.prepare(`INSERT INTO tokens(mint,name,symbol,image,quote,status,venue,dbc_pool,created_at,price)
            VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run(MINT, 'Realtime Test', 'RT', '/img/rt.png', 'REX', 'open', 'dbc', POOL, Date.now(), 0.005);

/** A confirmed swap, built the way the RPC actually returns one. */
function swapTx({ dq, dbase, loaded = false, slot = 100 }) {
  // ⛔ WHEN `loaded` IS SET THE VAULTS ARE REACHED THROUGH AN ADDRESS LOOKUP TABLE, which is how
  // Meteora actually sends them. They are then absent from staticAccountKeys entirely and
  // accountIndex counts past its end into meta.loadedAddresses. Reading only the static keys is the
  // bug that made the indexer report a pool with 300 trades as idle — twice.
  const statics = loaded ? [TRADER] : [TRADER, BASE_V, QUOTE_V];
  const loadedAddresses = loaded ? { writable: [BASE_V, QUOTE_V], readonly: [] } : { writable: [], readonly: [] };
  const iBase = loaded ? 1 : 1, iQuote = loaded ? 2 : 2;
  const bal = (i, amt) => ({ accountIndex: i, uiTokenAmount: { uiAmount: amt } });
  return {
    // ⛔ NOW, not a fixed epoch. A hardcoded blockTime silently ages: 1_760_000_000 is Oct 2025,
    // so every candle this suite wrote landed a year in the past and the 24h-change assertions
    // below measured against history that should not have existed.
    slot, blockTime: Math.floor(Date.now() / 1000),
    transaction: { message: { staticAccountKeys: statics } },
    meta: {
      err: null, loadedAddresses,
      preTokenBalances: [bal(iBase, 1_000_000), bal(iQuote, 0)],
      postTokenBalances: [bal(iBase, 1_000_000 + dbase), bal(iQuote, 0 + dq)],
    },
  };
}

/** A stub RPC serving exactly the signatures and transactions a case wants. */
const stub = (txs) => ({
  getSignaturesForAddress: async (_a, opts) => (opts?.before ? [] : txs.map((t, i) => ({ signature: `sig${i}`, slot: t.slot, err: null }))),
  getTransaction: async (sig) => txs[Number(String(sig).replace('sig', ''))] || null,
});
const MET = { client: async () => ({ state: { getPool: async () => ({ poolState: { baseVault: { toBase58: () => BASE_V }, quoteVault: { toBase58: () => QUOTE_V } } }) } }) };
const CH = { isPublicRpc: () => false };
const row = () => db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT);

console.log('\n── a buy reaches the tape AND the event queue');
{
  ENG.events.length = 0;
  const n = await indexPool(stub([swapTx({ dq: 500, dbase: -100_000 })]), row(), MET, CH);
  ok(n === 1, `indexed one trade (got ${n})`);
  const t = db.prepare('SELECT * FROM trades WHERE mint=?').get(MINT);
  ok(t?.side === 'buy', `stored as a buy (quote into the pool) — got ${t?.side}`);
  ok(Math.abs(t.price - 0.005) < 1e-9, `priced quote/tokens = 0.005 — got ${t?.price}`);
  ok(ENG.events.length === 1, `ONE event was queued for the open pages (got ${ENG.events.length})`);
  const ev = ENG.events[0] || {};
  ok(ev.type === 'trade', `event type is "trade", so every existing listener matches — got ${ev.type}`);
  // Each of these is read by a live board. A missing one is a column that silently stops updating.
  for (const k of ['mint', 'wallet', 'side', 'quote', 'tokens', 'price', 'ts', 'symbol', 'name', 'image', 'quoteSymbol']) {
    ok(ev[k] !== undefined && ev[k] !== null, `event carries ${k}`);
  }
  ok(ev.kind === 'dbc', 'event is tagged kind:"dbc" so the tape can label the venue');
  ok(ev.candle && typeof ev.candle.c === 'number', 'event carries the candle, so a chart can advance without refetching');
  ok(db.prepare('SELECT COUNT(*) c FROM candles WHERE mint=?').get(MINT).c === 1, 'and the candle was written');
}

console.log('\n── a sell is not an inverted buy');
{
  ENG.events.length = 0;
  db.prepare('UPDATE tokens SET dbc_last_sig=NULL, dbc_backfilled=1 WHERE mint=?').run(MINT);
  await indexPool(stub([swapTx({ dq: -300, dbase: 60_000, slot: 200 })]), row(), MET, CH);
  ok(ENG.events[0]?.side === 'sell', `quote leaving the pool is a sell — got ${ENG.events[0]?.side}`);
}

console.log('\n── vaults behind an address lookup table still produce a trade');
{
  ENG.events.length = 0;
  db.prepare('UPDATE tokens SET dbc_last_sig=NULL WHERE mint=?').run(MINT);
  await indexPool(stub([swapTx({ dq: 700, dbase: -140_000, loaded: true, slot: 300 })]), row(), MET, CH);
  ok(ENG.events.length === 1, 'the swap was found in meta.loadedAddresses, not only staticAccountKeys');
}

console.log('\n── and a non-swap is never broadcast');
{
  ENG.events.length = 0;
  db.prepare('UPDATE tokens SET dbc_last_sig=NULL WHERE mint=?').run(MINT);
  // A fee claim moves the quote vault and nothing else. It is not a trade and must not reach a tape.
  const claim = swapTx({ dq: -50, dbase: 0, slot: 400 });
  await indexPool(stub([claim]), row(), MET, CH);
  ok(ENG.events.length === 0, 'a one-sided balance change queued nothing');
}

console.log('\n── the same pass running twice does not double-count');
{
  ENG.events.length = 0;
  db.prepare('UPDATE tokens SET dbc_last_sig=NULL WHERE mint=?').run(MINT);
  const tx = swapTx({ dq: 900, dbase: -180_000, slot: 500 });
  await indexPool(stub([tx]), row(), MET, CH);
  const first = ENG.events.length;
  db.prepare('UPDATE tokens SET dbc_last_sig=NULL WHERE mint=?').run(MINT);
  await indexPool(stub([tx]), row(), MET, CH);
  ok(first === 1 && ENG.events.length === 1, `re-reading the same signature queued nothing new (${ENG.events.length} total)`);
}

console.log('\n── the client actually listens');
{
  const src = fs.readFileSync('public/pages.js', 'utf8');
  // A server that broadcasts to a page with no subscription is the same frozen board.
  const subs = src.match(/bus\.on\('trade'/g) || [];
  ok(subs.length >= 3, `pages.js subscribes to 'trade' in ${subs.length} places (pairs, leaderboard, coin page)`);
  ok(/bus\.on\('graduated'/.test(src), "and to 'graduated', so a migration redraws too");
  // ⛔ A subscription that outlives its page leaks a listener per navigation and eventually
  // re-renders a view that is no longer mounted.
  ok(/offs\s*=\s*\[[^\]]*bus\.on/.test(src) && /offs\.forEach/.test(src), 'subscriptions are collected and released on teardown');
}

// ⛔ "+0.0%" ON EVERY NEW PAIR. A coin younger than the window has no candle before it, and the
// engine reported that absence as a change of 0 — which renders "+0.0%" in green and reads as
// "traded, finished flat". The owner's board showed five pairs all claiming to be unchanged while
// they were moving several percent a minute, and it looked like broken data because it was: a
// measurement nobody had made, stated as a fact. null is the honest answer and formats as "—".
console.log('\n── an unmeasurable window says so, instead of claiming it was flat');
{
  const row = db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT);
  db.prepare("UPDATE tokens SET status='live' WHERE mint=?").run(MINT);
  const t = ENG.publicToken(db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT), { windows: true });
  // Every candle in this suite was written moments ago, so nothing reaches back a day or a week.
  ok(t.chg24h === null, `chg24h is null, not 0, with no candle 24h back (got ${JSON.stringify(t.chg24h)})`);
  ok(t.chg7d === null, `chg7d is null (got ${JSON.stringify(t.chg7d)})`);
  ok(t.chg30d === null, `chg30d is null (got ${JSON.stringify(t.chg30d)})`);
  // chgAll compares against the FIRST price, which does exist — so it must still be a number.
  ok(typeof t.chgAll === 'number', `chgAll is still measured, because the first price exists (got ${JSON.stringify(t.chgAll)})`);

  // Give it a price a day old and the figure must come back as a real number.
  const dayAgo = Math.floor((Date.now() - 36 * 3_600_000) / 60_000) * 60_000;
  db.prepare('INSERT OR REPLACE INTO candles(mint,ts,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,?,1)').run(MINT, dayAgo, 0.001, 0.001, 0.001, 0.001, 1);
  const t2 = ENG.publicToken(db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT), { windows: true });
  ok(typeof t2.chg24h === 'number' && t2.chg24h > 0, `once a 24h-old price exists the figure is real (got ${t2.chg24h})`);

  // And the formatter the board uses must turn null into a dash rather than "+0.0%".
  const ui = fs.readFileSync('public/ui.js', 'utf8');
  const m = /export const pct = ([^\n]+)/.exec(ui);
  const pct = eval('(' + m[1].replace(/;\s*$/, '') + ')');
  ok(pct(null) === '—', `pct(null) renders "${pct(null)}"`);
  ok(pct(0) === '+0.0%', 'a genuine zero still renders "+0.0%" — flat is a real result and must look different from unknown');
  ok(/const signed = \(n, dp = 1\) => pct\(n, dp\)/.test(fs.readFileSync('public/pages.js', 'utf8')),
    'the pairs board formats through pct(), so it cannot print +0.0% for null again');
  // A null must not render green either: `null >= 0` is true, which is how it got a green +0.0%.
  const pg = fs.readFileSync('public/pages.js', 'utf8');
  ok(!/\$\{[a-z]\.chg\w* >= 0 \? 'up' : 'down'\}/.test(pg), 'no class expression still treats null as a gain');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
