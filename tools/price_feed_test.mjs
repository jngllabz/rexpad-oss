// The price feed, and the silent failure it was built to make impossible.
//
// ⛔ DEXSCREENER ANSWERS A THROTTLED CALLER WITH HTTP 200 AND AN EMPTY BODY. Not a 429, not an
// error — a perfectly ordinary success with no pairs in it. That is why sixteen of our thirty-eight
// quotes sat on prices compiled into the source: every refresh "succeeded" and changed nothing,
// and the only trace was one warning line per symbol per minute.
//
//   node tools/price_feed_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-px-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'px.sqlite';
process.env.RPC_URL = 'https://mainnet.example.com/?api-key=0123456789012345678901234567890123456';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const SOL = 'So11111111111111111111111111111111111111112';
const real = globalThis.fetch;
let calls = [];
const serve = (fn) => { globalThis.fetch = async (url, opts) => { calls.push(String(url)); return fn(String(url), opts); }; };
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const isJup = (url) => url.includes('jup.ag');
const mintsIn = (url) => (isJup(url) ? new URL(url).searchParams.get('ids') : url.split('/').pop()).split(',');
/** Answer in whichever shape the source being called expects. */
const priced = (url, price) => isJup(url)
  ? jsonRes(Object.fromEntries(mintsIn(url).map((m) => [m, { usdPrice: price(m), liquidity: 50_000 }])))
  : jsonRes(mintsIn(url).map((m) => ({ baseToken: { address: m }, priceUsd: String(price(m)), liquidity: { usd: 50_000 } })));

const P = await import('../lib/prices.mjs');
const quotes = () => P.quoteList().filter((q) => q.category !== 'stable');

console.log('── one request per batch, not one per mint');
{
  calls = [];
  serve((url) => priced(url, (m) => (m === SOL ? 115.5 : 1.25)));
  await P.refreshPrices();
  // ⛔ BOUND THE REQUESTS BY THE CHUNKING, NOT BY A NUMBER THAT HAPPENED TO FIT. This asserted
  // `<= 2`, which was true only while the quote list was short enough: DexScreener's documented
  // ceiling is 30 mints per lookup and every chunk carries SOL as its canary, so 29 real quotes
  // fit in each. Adding a 59th quote crossed the boundary and failed a test whose actual point —
  // batch, never one request per mint — was not violated at all. A magic constant that tracks the
  // data rather than the rule turns ordinary growth into a red build.
  const perChunk = 29;
  const expected = Math.ceil(quotes().length / perChunk);
  ok(calls.length <= expected,
    `${calls.length} request(s) for ${quotes().length} quotes in chunks of ${perChunk} (expected at most ${expected}, and never one per mint)`);
  ok(calls.length < quotes().length / 4, 'and that is batching, not one request per mint');
  ok(calls.every((u) => u.includes(SOL)), 'every batch carries the SOL canary');
  ok(P.unpricedQuotes().length === 0, 'every quote resolved');
  ok(P.priceAgeOf('ETH') !== null && P.priceAgeOf('ETH') < 5_000, 'and carries a fresh age');
}

console.log('\n── ⛔ A 200 WITH AN EMPTY BODY IS A THROTTLE, NOT THIRTY DEAD TOKENS');
{
  const before = Object.fromEntries(quotes().map((q) => [q.symbol, q.usd]));
  calls = [];
  serve(() => jsonRes([]));                       // exactly what a rate-limited caller is served
  await P.refreshPrices();
  const after = Object.fromEntries(quotes().map((q) => [q.symbol, q.usd]));
  ok(Object.keys(before).every((k) => before[k] === after[k]), 'not one price was changed by the empty answer');
  ok(P.unpricedQuotes().length === 0, 'and nothing was marked as having no price');
}

console.log('\n── being ignored makes it back off instead of hammering');
{
  calls = [];
  serve(() => jsonRes([]));
  await P.refreshPrices();
  await P.refreshPrices();
  await P.refreshPrices();
  ok(calls.length <= 1, `${calls.length} request(s) across three refreshes while in cooldown`);
}

console.log('\n── a chunk that answers WITHOUT the canary is not believed either');
{
  // ⛔ A FRESH MODULE INSTANCE, or the cooldown from the previous case swallows the refresh and the
  // assertion passes without the code under test ever running. A test that cannot fail is not a test.
  const fresh = await import(`../lib/prices.mjs?canary=${Date.now()}`);
  const eth0 = fresh.quoteList().find((q) => q.symbol === 'ETH').usd;
  calls = [];
  // The aggregator replies, and the reply even has prices in it — but SOL is missing, which can only
  // mean we were not really served. A naive reader would take these numbers at face value.
  serve((url) => (isJup(url)
    ? jsonRes(Object.fromEntries(mintsIn(url).filter((m) => m !== SOL).map((m) => [m, { usdPrice: 1, liquidity: 10 }])))
    : jsonRes(mintsIn(url).filter((m) => m !== SOL).map((m) => ({ baseToken: { address: m }, priceUsd: '1.00', liquidity: { usd: 10 } })))));
  await fresh.refreshPrices();
  const eth1 = fresh.quoteList().find((q) => q.symbol === 'ETH');
  ok(calls.length > 0, 'the refresh really ran (it was not short-circuited by a cooldown)');
  ok(eth1.usd === eth0, `a canary-less answer did not move ETH off ${eth0}`);
  ok(eth1.priceLive === false, 'and ETH is still reported as not having a live price');
}

console.log('\n── the deepest pool sets the price, not the first one listed');
{
  const fresh = await import(`../lib/prices.mjs?deep=${Date.now()}`);
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // Jupiter is asked first and declines, so this exercises DexScreener's deepest-pool rule.
    if (isJup(String(url))) return jsonRes({});
    const rows = [];
    for (const m of mintsIn(String(url))) {
      rows.push({ baseToken: { address: m }, priceUsd: '0.01', liquidity: { usd: 5 } });        // junk pool
      rows.push({ baseToken: { address: m }, priceUsd: m === SOL ? '115.5' : '7.77', liquidity: { usd: 900_000 } }); // real one
    }
    return jsonRes(rows);
  };
  await fresh.refreshPrices();
  const eth = fresh.quoteList().find((q) => q.symbol === 'ETH');
  ok(eth.usd === 7.77, `ETH took the deep pool (${eth.usd}), not the $5 one`);
  ok(eth.priceLive === true, 'and is marked live');
}

console.log('\n── a quote nobody carries is remembered as such, and stops being asked about');
{
  const fresh = await import(`../lib/prices.mjs?none=${Date.now()}`);
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // Only the canary answers. Everything else genuinely has no pools anywhere.
    return priced(String(url), (m) => (m === SOL ? 115.5 : 0));
  };
  await fresh.refreshPrices();
  const n1 = calls.length;
  calls = [];
  await fresh.refreshPrices();
  ok(calls.length === 0, `asked ${n1} time(s), then stopped (a 15-minute cooldown, not every tick)`);
  ok(fresh.unpricedQuotes().length > 0, 'and they are reported as unpriced rather than quoted from a constant');
}

console.log('\n── ⛔ ONE SOURCE GOING QUIET MUST NOT MEAN NO PRICES');
{
  const fresh = await import(`../lib/prices.mjs?src=${Date.now()}`);
  calls = [];
  // Jupiter is down — exactly as DexScreener was on 7 Oct: 200, and nothing in it.
  serve((url) => (isJup(url) ? jsonRes({}) : priced(url, (m) => (m === SOL ? 115.5 : 3.33))));
  await fresh.refreshPrices();
  ok(calls.some((u) => u.includes('jup.ag')), 'the first source was tried');
  ok(calls.some((u) => u.includes('dexscreener')), 'and the second was reached when it said nothing');
  ok(fresh.priceSource() === 'dexscreener', `served by ${fresh.priceSource()}`);
  ok(fresh.unpricedQuotes().length === 0, 'every quote still got a price');
}

console.log('\n── the preferred source is used when it answers, and the other is not even asked');
{
  const fresh = await import(`../lib/prices.mjs?pref=${Date.now()}`);
  calls = [];
  serve((url) => (isJup(url) ? priced(url, (m) => (m === SOL ? 115.5 : 9.99)) : jsonRes([])));
  await fresh.refreshPrices();
  ok(fresh.priceSource() === 'jupiter', 'jupiter served it');
  ok(!calls.some((u) => u.includes('dexscreener')), 'dexscreener was never called');
}

console.log('\n── every source silent is a cooldown, not a wipe');
{
  const fresh = await import(`../lib/prices.mjs?dead=${Date.now()}`);
  const before = fresh.quoteList().find((q) => q.symbol === 'ETH').usd;
  serve(() => jsonRes({}));
  await fresh.refreshPrices();
  const after = fresh.quoteList().find((q) => q.symbol === 'ETH');
  ok(after.usd === before, `ETH held at ${before} with both sources quiet`);
  ok(after.priceLive === false, 'and is honestly reported as not live');
}

globalThis.fetch = real;
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
