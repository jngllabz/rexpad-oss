// A coin can pay its holders in several assets at once, and every number must keep its unit.
//
// ⛔ WHAT THIS REPLACES. `payout_asset` has been in the schema for weeks, whitelisted on write and
// surfaced in publicToken, and READ BY NOTHING THAT PAYS — its own comment says it "swaps the fee
// before distributing", which was never true. Every coin on the board has it NULL. This is the
// working version, so the thing it must never become is another column that stores an intention.
//
// The failure this guards hardest is a number with no unit: a payout row denominated in DOGE but
// summed, priced or ordered as though it were the coin's quote. payout.mjs already carries a scar
// from exactly that — 15,674 REX ($2.98) outranking 0.0736 SOL ($15.45) in the send queue.
//
//   node tools/payout_basket_test.mjs
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-basket-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'basket.sqlite';
process.env.SIM = '1';
// A $20 holder floor and a NULL price would make every holder ineligible, which would make this
// whole file pass vacuously against an epoch that paid nobody.
process.env.REWARD_FLOOR_USD = '0';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { db } = await import('../lib/db.mjs');
const E = await import('../lib/engine.mjs');
const PO = await import('../lib/payout.mjs');

// ---------- the validator ----------
const good = [{ asset: 'DOGE', bps: 4000 }, { asset: 'WIF', bps: 4000 }, { asset: 'SOL', bps: 2000 }];
ok(E.normalizeBasket(good).json, 'a basket of three real assets summing to 10000 is accepted');
ok(E.normalizeBasket(null).json === null, 'no basket at all is fine — that is "pay in the quote"');

const bad = {
  'shares that do not sum to 10000': [{ asset: 'DOGE', bps: 4000 }, { asset: 'WIF', bps: 4000 }],
  // ⛔ A TICKER THAT CANNOT BECOME REAL. This said PEPE, which was true for about a day and then
  // stopped being: PEPE was added as a quote on 24 Oct and this assertion failed, reporting the
  // validator as broken when the only thing that had changed was the world. A negative example
  // has to be something nothing will ever list.
  'an asset this platform cannot pay in': [{ asset: 'NOT_A_REAL_TICKER_XYZ', bps: 10_000 }],
  'the same asset twice': [{ asset: 'DOGE', bps: 5000 }, { asset: 'DOGE', bps: 5000 }],
  'a zero share': [{ asset: 'DOGE', bps: 10_000 }, { asset: 'WIF', bps: 0 }],
  'a negative share': [{ asset: 'DOGE', bps: 11_000 }, { asset: 'WIF', bps: -1000 }],
  'an empty list': [],
};
for (const [why, legs] of Object.entries(bad)) {
  const r = E.normalizeBasket(legs);
  ok(!!r.error && !r.json, `refused: ${why} — "${r.error || 'NO ERROR, WHICH IS THE BUG'}"`);
}
// ⛔ 9,700 is the one that matters: it would underpay every holder forever and look like dust.
ok(/9700/.test(E.normalizeBasket([{ asset: 'DOGE', bps: 9700 }]).error || ''),
  'and the error names the number, so a creator can see what is missing');

// The writer and the reader must agree, because two validators drift and the drift only shows up
// at the first epoch, after the coin is live.
const stored = E.normalizeBasket(good).json;
ok(E.payoutBasket({ payout_assets: stored })?.legs?.length === 3,
  'what the writer stores is exactly what the reader accepts');
ok(E.payoutBasket({ payout_assets: '{not json' })?.error, 'a corrupted column reports an error rather than paying the quote');
ok(E.payoutBasket({ payout_assets: null }) === null, 'a NULL column means "pay in the quote", not "broken"');

// ---------- the epoch ----------
const MINT = 'BasketCoin11111111111111111111111111111111';
const QUOTE = 'REX';
const W1 = 'Holder1111111111111111111111111111111111111';
const W2 = 'Holder2222222222222222222222222222222222222';

db.prepare(`INSERT INTO tokens (mint,name,symbol,creator,quote,quote_mint,status,venue,holder_bps,rex_bps,
    yield_pool,payout_assets,payout_rule,payout_n,price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(MINT, 'Basket Coin', 'BSKT', W1, QUOTE, 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump',
    'live', 'dbc', 100, 50, 1000, stored, 'all', 25, 0.001);
for (const w of [W1, W2]) {
  db.prepare('INSERT OR REPLACE INTO wallets(wallet,bot) VALUES(?,0)').run(w);
  db.prepare('INSERT OR REPLACE INTO holdings(wallet,mint,amount,cost,held_since,yield_earned) VALUES(?,?,?,?,?,0)')
    .run(w, MINT, 500_000, 1, Date.now() - 86_400_000);
}

E.runEpoch();

const allRows = db.prepare('SELECT wallet, asset, asset_mint, amount FROM payouts WHERE mint=?').all(MINT);
ok(allRows.length > 0, 'the epoch paid something');
// ⛔ THE OPS ROW IS DELIBERATELY NOT A BASKET ROW. The platform's slice is taken off the top of
// the pool as collected, in the QUOTE, and nothing swaps it — so it carries a NULL asset like any
// pre-basket row. Asserting over it as though it were a holder payout would demand the basket
// convert money that was never the holders' to begin with.
const opsRows = allRows.filter((r) => r.asset === null);
const rows = allRows.filter((r) => r.asset !== null);
ok(opsRows.every((r) => r.asset_mint === null), 'the ops cut stays in the quote, unswapped');
const assets = [...new Set(rows.map((r) => r.asset))].sort();
ok(assets.length === 3 && assets.join(',') === 'DOGE,SOL,WIF',
  `one row per asset per holder — got ${assets.join(',')}`);
ok(rows.length > 0 && rows.every((r) => r.asset_mint && r.asset_mint.length > 30),
  'every basket row carries its own mint, which is what the claim rail groups by');
ok(rows.length > 0 && rows.every((r) => Number.isFinite(r.amount) && r.amount > 0),
  '⛔ no row is NaN or Infinity — a dead price must never be written as an amount');

// The split must honour the weights, measured in DOLLARS, since the legs are different assets.
const { QUOTES } = await import('../lib/prices.mjs');
const usd = (sym, amt) => amt * (QUOTES[sym]?.usd || 0);
const byAsset = {};
for (const r of rows) byAsset[r.asset] = (byAsset[r.asset] || 0) + usd(r.asset, r.amount);
const totalUsd = Object.values(byAsset).reduce((a, b) => a + b, 0);
const share = (s) => byAsset[s] / totalUsd;
ok(Math.abs(share('DOGE') - 0.4) < 0.02, `DOGE got ~40% of the value (${(share('DOGE') * 100).toFixed(1)}%)`);
ok(Math.abs(share('WIF') - 0.4) < 0.02, `WIF got ~40% (${(share('WIF') * 100).toFixed(1)}%)`);
ok(Math.abs(share('SOL') - 0.2) < 0.02, `SOL got ~20% (${(share('SOL') * 100).toFixed(1)}%)`);

// ---------- the claim rail groups by the row's asset, not the coin's quote ----------
const due = PO.holderDue(W1);
const dueAssets = due.map((g) => g.quote).sort();
ok(due.length === 3 && dueAssets.join(',') === 'DOGE,SOL,WIF',
  `holderDue splits the claim by asset — got ${dueAssets.join(',')}`);
ok(due.length > 0 && due.every((g) => g.quoteMint && g.quoteMint !== 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump'),
  '⛔ and none of them resolved to the coin\'s REX quote, which is the bug this exists to prevent');

// ---------- a coin with NO basket is completely unchanged ----------
const PLAIN = 'PlainCoin111111111111111111111111111111111';
db.prepare(`INSERT INTO tokens (mint,name,symbol,creator,quote,quote_mint,status,venue,holder_bps,rex_bps,yield_pool,price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(PLAIN, 'Plain', 'PLAIN', W1, QUOTE, 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump', 'live', 'dbc', 100, 50, 1000, 0.001);
db.prepare('INSERT OR REPLACE INTO holdings(wallet,mint,amount,cost,held_since,yield_earned) VALUES(?,?,?,?,?,0)')
  .run(W2, PLAIN, 500_000, 1, Date.now() - 86_400_000);
E.runEpoch();
const plainRows = db.prepare('SELECT asset, asset_mint FROM payouts WHERE mint=?').all(PLAIN);
ok(plainRows.length > 0 && plainRows.every((r) => r.asset === null && r.asset_mint === null),
  'a coin without a basket still writes NULL asset — which COALESCE reads as its quote');
const plainDue = PO.holderDue(W2).filter((g) => g.quote === QUOTE);
ok(plainDue.length === 1, 'and it still claims in its quote, exactly as before baskets existed');

// ---------- a broken basket stops THAT coin only ----------
const BROKE = 'BrokeCoin111111111111111111111111111111111';
db.prepare(`INSERT INTO tokens (mint,name,symbol,creator,quote,quote_mint,status,venue,holder_bps,rex_bps,yield_pool,payout_assets,price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(BROKE, 'Broke', 'BROKE', W1, QUOTE, 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump', 'live', 'dbc', 100, 50, 1000, '[{"asset":"NOPE","bps":10000}]', 0.001);
db.prepare('INSERT OR REPLACE INTO holdings(wallet,mint,amount,cost,held_since,yield_earned) VALUES(?,?,?,?,?,0)')
  .run(W2, BROKE, 500_000, 1, Date.now() - 86_400_000);
const before = db.prepare('SELECT yield_pool FROM tokens WHERE mint=?').get(BROKE).yield_pool;
let epochThrew = null;
try { E.runEpoch(); } catch (e) { epochThrew = e.message; }
ok(!epochThrew, `a broken basket does not take the whole epoch down with it (${epochThrew || 'no throw'})`);
ok(db.prepare('SELECT COUNT(*) n FROM payouts WHERE mint=?').get(BROKE).n === 0,
  '⛔ and it pays NOTHING rather than quietly paying the quote the creator did not ask for');
ok(db.prepare('SELECT yield_pool FROM tokens WHERE mint=?').get(BROKE).yield_pool === before,
  'its pool rolls forward intact, so the money is recoverable once the basket is fixed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
