// A coin we do not price must SAY SO, not answer with a row of nulls.
//
// ⛔ WHAT WAS LIVE: every one of the 100 coins on the board sits on the Meteora (dbc) venue, so
// their curve lives in Meteora's pool and v_quote/v_tokens/k/real_tokens are NULL in our row.
// JS coerces those NULLs to 0, which makes `out >= t.real_tokens - 1e-6` true on the FIRST
// comparison — so previewBuy took the GRADUATION branch, divided by `t.v_tokens - out` = 0, and
// returned NaN everywhere. `/api/quote` is a documented public endpoint ("Price a trade before it
// happens") and it answered 200 with every field null while still reporting `graduates: true`.
//
// Nothing was ever written: `debit` refuses a non-finite amount and `buy` runs inside a
// transaction. But the slippage guard in `buy` did NOT catch it — `p.tokensOut` is null, so
// `null < minTokens` is `0 < 0`, which is false — and the only thing standing between a trade
// call and the ledger was an error message that said "Bad amount".
//
//   node tools/offcurve_quote_test.mjs [baseUrl]
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-offcurve-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'offcurve.sqlite';
process.env.SIM = '1';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const E = await import('../lib/engine.mjs');

// A row shaped exactly like a live DBC coin: real metadata, empty curve columns.
const dbcRow = {
  mint: 'DbcLike1111111111111111111111111111111111', symbol: 'DBCL', quote: 'SOL',
  status: 'live', venue: 'dbc', holder_bps: 100, rex_bps: 50,
  v_quote: null, v_tokens: null, k: null, real_tokens: null, real_quote: null,
};
const llRow = { ...dbcRow, venue: 'launchlab' };

// ---- the two venues we do not price ----
const buyErr = threw(() => E.previewBuy(dbcRow, 1));
ok(buyErr !== null, '⛔ a buy quote on a Meteora coin is refused, not answered with nulls');
ok(/Meteora/.test(buyErr || ''), `it names the venue that DOES price it — got: "${buyErr}"`);
ok(!/Bad amount/.test(buyErr || ''), 'and it is not the opaque "Bad amount" that debit used to raise');

const sellErr = threw(() => E.previewSell(dbcRow, 1));
ok(sellErr !== null && /Meteora/.test(sellErr), 'the sell side is refused the same way');

const llErr = threw(() => E.previewBuy(llRow, 1));
ok(llErr !== null && /LaunchLab/.test(llErr), 'a LaunchLab coin names LaunchLab, not Meteora');

// ---- the NaN shape itself must be unreachable ----
// This is the real assertion: whatever happens, a quote must never come back finite-looking-but-null.
for (const row of [dbcRow, llRow]) {
  let q = null;
  try { q = E.previewBuy(row, 1); } catch { /* refused, which is the point */ }
  ok(q === null, `${row.venue}: no quote object is produced at all, so no null-filled 200 can be served`);
}

// ---- and our OWN curve must still price normally ----
// ⛔ The guard keys on an EXPLICIT foreign venue. A NULL/absent venue means our own curve — see
// publicToken, which reads `t.venue || 'rexpad'` — and engine_test.mjs passes a bare curveInit
// object with no venue field at all. Breaking that would break every internal quote.
const own = { ...E.curveInit('SOL'), status: 'live', holder_bps: 100 };
const q1 = E.previewBuy(own, 5);
ok(Number.isFinite(q1.tokensOut) && q1.tokensOut > 0, 'a coin with NO venue field still quotes (that is our own curve)');
ok(Number.isFinite(q1.avgPrice) && q1.avgPrice > 0, 'and its price is a real number');

const owned = { ...own, venue: 'rexpad' };
ok(Number.isFinite(E.previewBuy(owned, 5).tokensOut), 'an explicit rexpad venue quotes too');

// The amount check must still come first, so its existing error messages do not change.
ok(/positive/.test(threw(() => E.previewBuy(dbcRow, 0)) || ''),
  'a zero amount is still rejected as an amount, before the venue is considered');

ok(E.offCurve(dbcRow) === 'dbc' && E.offCurve(own) === null,
  'offCurve() reports the foreign venue and stays silent for our own');

// ---- over HTTP, if a server was given ----
const base = process.argv[2] || process.env.BASE;
if (base) {
  const r = await fetch(`${base}/api/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mint: 'definitely-not-a-real-mint', amount: 1, side: 'buy' }),
  }).catch(() => null);
  ok(r && r.status === 404, 'an unknown mint is still a 404 over HTTP');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
