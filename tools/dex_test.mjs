// The aggregator-facing contract, turned into assertions.
//
// `/dex/latest-block` is a PROMISE: everything up to that block has been reported. DexScreener moves
// its own cursor past what we answer and never asks again, so a block claimed above a missing trade
// is a hole in the chart that can never be filled — in theirs and in ours. Every check here exists
// because some plausible-looking change would break that promise quietly.
//
// Runs entirely offline against a scratch database. No RPC, no server.
//   DATA_DIR=/tmp/rexdex node tools/dex_test.mjs
process.env.SIM = process.env.SIM || '1';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/rexdex-' + Date.now();

const { db, meta: kv } = await import('../lib/db.mjs');
const IX = await import('../lib/indexer.mjs');
const DS = await import('../lib/dexscreener.mjs');
const { QUOTES } = await import('../lib/prices.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const SOL = QUOTES.SOL.mint;
const MINT = 'TestMint1111111111111111111111111111111111';
const WALLET = 'TestWallet11111111111111111111111111111111';

db.prepare('DELETE FROM trades').run();
db.prepare('DELETE FROM candles').run();
db.prepare('DELETE FROM tokens WHERE mint=?').run(MINT);
db.prepare(`INSERT INTO tokens(mint,name,symbol,quote,status,price,trades,volume,tax_bps,real_quote,real_tokens,v_quote,v_tokens)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(MINT, 'Test', 'TST', 'SOL', 'live', 0, 0, 0, 300, 10, 1000, 30, 1_000_000);

const tokenRow = () => db.prepare('SELECT trades, volume FROM tokens WHERE mint=?').get(MINT);
const trade = (over = {}) => IX.recordTrade({
  launchMint: MINT, user: WALLET, isBuy: true, quote: 1_000_000n, tokens: 1_000_000n,
  quoteMint: SOL, slot: 900, sig: 'SIG_A', evIx: 0, ts: Date.now(), ...over,
});

// ---------------------------------------------------------------- 1. the dedupe key
// Both feeds record the same trade by design. Without an identity for the row, the backfill would
// re-add every trade it re-walked and double the volume, the trade count and the candle.
{
  const before = tokenRow();
  ok(trade() === 'new', 'D1 a trade the database has never seen is new');
  const once = tokenRow();
  ok(trade() === 'dup', 'D2 the SAME (sig, event) recorded again is a duplicate, not a second trade');
  const after = tokenRow();
  ok(after.trades === before.trades + 1, 'D3 the duplicate did not increment the trade count');
  // Asserted as a delta rather than a figure: what matters is that the second call added NOTHING,
  // whatever the quote asset's decimals happen to make the first one worth.
  ok(once.volume > before.volume && after.volume === once.volume,
    'D4 the first recording added volume and the duplicate added none');
  ok(db.prepare('SELECT COUNT(*) n FROM trades WHERE sig=?').get('SIG_A').n === 1, 'D5 exactly one row survives');
}

// One transaction can carry more than one Traded event, so the signature ALONE cannot be the key.
{
  ok(trade({ evIx: 1 }) === 'new', 'D6 a second event in the same transaction is its own trade');
  ok(db.prepare('SELECT COUNT(*) n FROM trades WHERE sig=?').get('SIG_A').n === 2, 'D7 both events are kept');
}

// ---------------------------------------------------------------- 2. nothing is recorded blind
{
  ok(IX.recordTrade({ launchMint: 'NotIndexed111111111111111111111111111111', user: WALLET, isBuy: true,
    quote: 1n, tokens: 1n, quoteMint: SOL, slot: 901, sig: 'SIG_B', evIx: 0 }) === 'unknown',
    'U1 a trade on an unindexed launch reports unknown rather than being dropped');
  ok(db.prepare('SELECT COUNT(*) n FROM trades WHERE sig=?').get('SIG_B').n === 0, 'U2 and writes nothing');
}

// The direction bug: the IDL says `is_buy`, so reading `isBuy` returned undefined and every trade
// was filed as a sell. Undefined must now be a decode failure, never a guessed side.
{
  ok(IX.isBuyOf({ is_buy: true }) === true, 'B1 is_buy true reads as a buy');
  ok(IX.isBuyOf({ is_buy: false }) === false, 'B2 is_buy false reads as a sell');
  ok(IX.isBuyOf({ isBuy: true }) === true, 'B3 the camelCase spelling is accepted too');
  ok(IX.isBuyOf({}) === null, 'B4 NEITHER spelling present is a decode failure, not a sell');
  ok(IX.isBuyOf({ is_buy: 'yes' }) === null, 'B5 a non-boolean is a decode failure too');
}

// ---------------------------------------------------------------- 3. a late trade is filed by BLOCK
// A trade recovered an hour later belongs in the candle its block fell in. Using the clock would
// invent a price move that never happened.
{
  const old = Date.now() - 3 * 3600_000;
  ok(trade({ sig: 'SIG_OLD', evIx: 0, ts: old, slot: 500 }) === 'new', 'T1 an old trade records');
  const bucket = Math.floor(old / 60_000) * 60_000;
  ok(!!db.prepare('SELECT 1 FROM candles WHERE mint=? AND ts=?').get(MINT, bucket),
    'T2 it lands in the candle for ITS OWN block time, not the current minute');
  ok(db.prepare('SELECT ts FROM trades WHERE sig=?').get('SIG_OLD').ts === old, 'T3 and keeps that timestamp');
}

// ---------------------------------------------------------------- 4. the promise itself
// THE regression test. A dropped log subscription leaves a hole, and the next trade to arrive still
// has a higher slot — so `latest-block` must follow the BACKFILL CURSOR and not the newest row we
// happen to hold, or it promises completeness across the hole.
{
  kv.set('backfill_slot', 800); kv.set('backfill_ts', 1700000000);
  const top = db.prepare('SELECT MAX(slot) s FROM trades').get().s;
  ok(top === 900, 'L0 the database does hold a trade above the cursor');
  const lb = DS.latestBlock().block;
  ok(lb.blockNumber === 800, 'L1 latest-block reports the CURSOR (800), not the newest trade (900)');
  ok(lb.blockTimestamp === 1700000000, 'L2 and the cursor transaction\'s own block time');

  // Answering beyond the cursor would publish a partially-read block as a complete one.
  const evs = DS.events(0, 1000).events;
  ok(evs.length > 0, 'L3 events in the complete range are served');
  ok(evs.every((e) => e.block.blockNumber <= 800), 'L4 events are CLAMPED to the cursor even when more is asked for');

  // The cursor moving is the only thing that publishes a trade.
  kv.set('backfill_slot', 900);
  ok(DS.latestBlock().block.blockNumber === 900, 'L5 advancing the cursor publishes the slot');
  ok(DS.events(0, 1000).events.some((e) => e.block.blockNumber === 900), 'L6 and its events become answerable');

  // No cursor at all must claim nothing, rather than falling back to the newest row.
  db.prepare("DELETE FROM meta WHERE k LIKE 'backfill%'").run();
  ok(DS.latestBlock().block.blockNumber === 0, 'L7 with no cursor the adapter claims block 0, not the newest trade');
}

// ---------------------------------------------------------------- 5. pair sides never flip
// DexScreener caches a pair's asset order forever, so flipping it later inverts every stored price.
{
  const a = DS.sides(MINT, SOL), b = DS.sides(MINT, SOL);
  ok(a.asset0 === b.asset0 && a.asset1 === b.asset1, 'P1 the side order is stable for a pair');
  ok(a.asset0 < a.asset1, 'P2 and is a property of the mints (sorted), not of insertion order');
  const p = DS.pair(MINT)?.pair;
  ok(p && p.asset0Id === a.asset0 && p.asset1Id === a.asset1, 'P3 the pair endpoint agrees with it');
  ok(p.feeBps === 300, 'P4 the fee reported is the whole fee a trader pays');
}

// ---------------------------------------------------------------- 6. paper mode claims nothing
{
  db.prepare('DELETE FROM trades').run();
  db.prepare("DELETE FROM meta WHERE k LIKE 'backfill%'").run();
  ok(DS.latestBlock().block.blockNumber === 0, 'S1 with no on-chain trades the adapter claims block 0');
  ok(DS.events(0, 1e9).events.length === 0, 'S2 and serves no events — feeding an aggregator simulated fills is worse than feeding it nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
