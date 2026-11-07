// The quick-buy ladder, extracted from the client and checked against money.
//
// ⛔ THE BUG THIS REPLACES: four hand-written ladders — SOL, USDC, REX, and `10K / 50K / 100K /
// 500K` for "everything else". Everything else was thirty-four of thirty-eight quote assets, so a
// coin paired against ETH offered a cheapest first buy of TEN THOUSAND ETH, about twenty-five
// million dollars. Julz launched $VEGETA against ETH and could not buy his own coin: every preset
// the panel gave him was unaffordable.
//
//   node tools/quickbuy_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

// Lift the two functions straight out of the shipped client, so this tests what runs rather than a
// copy that can drift away from it.
const src = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
const grab = (name, start) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`${name} not found in public/pages.js — the test is stale, not the code`);
  const j = src.indexOf('\n', i);
  return src.slice(i, j);
};
const niceSrc = grab('niceAmt', '  const niceAmt = (x) =>');
const labelSrc = grab('rungLabel', '  const rungLabel = (v) =>');
const niceAmt = eval(`(${niceSrc.split('=').slice(1).join('=').trim().replace(/;$/, '')})`);
const rungLabel = eval(`(${labelSrc.split('=').slice(1).join('=').trim().replace(/;$/, '')})`);

const ladder = (usd) => [10, 50, 100, 500].map((d) => niceAmt(d / usd));

console.log('── ⛔ EVERY RUNG IS AFFORDABLE, FOR EVERY ASSET WE OFFER');
{
  const assets = { SOL: 115.8, USDC: 1, REX: 0.0001055, ETH: 2569.12, WIF: 0.228, ZEC: 1323.44,
    GLDx: 376.36, xSOL: 0.08555, TSLAx: 377.73, DOGE: 0.08853, SNDKx: 1779.5, PENGU: 0.008467 };
  let worst = 0, worstSym = '';
  for (const [sym, usd] of Object.entries(assets)) {
    const rungs = ladder(usd).map((v) => v * usd);
    const top = Math.max(...rungs);
    if (top > worst) { worst = top; worstSym = sym; }
    ok(top <= 1200, `${sym.padEnd(6)} rungs top out at $${top.toFixed(0)}`);
  }
  ok(worst <= 1200, `the most expensive button across every asset is $${worst.toFixed(0)} (${worstSym})`);
}

console.log('\n── the old ladder, for comparison — this is what shipped');
{
  const old = [1e4, 5e4, 1e5, 5e5];
  const ethTop = old[0] * 2569.12;
  ok(ethTop > 20_000_000, `the OLD cheapest ETH button was $${(ethTop / 1e6).toFixed(1)}M — which is the bug`);
}

console.log('\n── it reproduces the hand-written SOL ladder exactly');
{
  const got = ladder(115.8);
  ok(JSON.stringify(got) === JSON.stringify([0.1, 0.5, 1, 5]), `SOL → ${got.join(' / ')} (was 0.1 / 0.5 / 1 / 5 by hand)`);
}

console.log('\n── and a dollar-pegged asset lands on round dollars');
{
  const got = ladder(1);
  ok(JSON.stringify(got) === JSON.stringify([10, 50, 100, 500]), `USDC → ${got.join(' / ')}`);
}

console.log('\n── rungs always rise, and never collide');
{
  for (const usd of [0.000001, 0.0001055, 0.008, 1, 115.8, 2569, 1779.5, 50_000]) {
    const r = ladder(usd);
    ok(r[0] < r[1] && r[1] < r[2] && r[2] < r[3], `$${usd}: ${r.join(' / ')} strictly increasing`);
  }
}

console.log('\n── labels read like something a person would type');
{
  const cases = [[0.1, '0.1'], [1, '1'], [5, '5'], [100, '100'], [1000, '1K'], [100000, '100K'], [1e6, '1M'], [5e6, '5M'], [2e9, '2B']];
  for (const [v, want] of cases) ok(rungLabel(v) === want, `${v} → "${rungLabel(v)}"`);
}

console.log('\n── a price of zero or nonsense never produces a rung');
{
  for (const bad of [0, -1, NaN, Infinity, null, undefined]) {
    ok(niceAmt(bad) === 0, `niceAmt(${String(bad)}) → 0, so the caller falls back to the fixed ladder`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
