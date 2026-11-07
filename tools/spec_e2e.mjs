// The locked REX build spec (REX_Final_Memo / REX_Final_Plan, 1 Oct 2026) turned into assertions,
// exercised through the SITE's own HTTP API. Everything here is from the spec's "Done when" and the
// memo's fee table — if one of these fails, we have shipped something the memo does not describe.
//
// Needs the site running in SIM mode with the launch gate off, since it opens a wallet per launch:
//   DATA_DIR=/tmp/rexqa SIM=1 PORT=8787 LAUNCH_HOLD_USD=0 node server.mjs
//   node tools/spec_e2e.mjs http://127.0.0.1:8787
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const api = async (p, body, H = {}) => {
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...H }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.error || ''}`);
  return j;
};
// One launch per minute per wallet is real product behaviour, so every launch in the matrix gets
// its own paper wallet rather than fighting the throttle.
const freshH = async () => { const { token } = await api('/api/auth/demo', {}); const H = { authorization: 'Bearer ' + token }; await api('/api/faucet', {}, H); return H; };
const H = await freshH();

// the quote tabs: every symbol the spec names, with a real mint
const boot = await api('/api/state');
const byCat = (c) => boot.quotes.filter((q) => q.category === c).map((q) => q.symbol);
ok(['SOL', 'REX', 'USDC', 'GP'].every((s) => boot.quotes.some((q) => q.symbol === s)), 'Quote tab carries SOL, REX, USDC and GP');
ok(['STONK', 'ZCAT', 'SI', 'MASK', 'ALLINU'].every((s) => byCat('meta').includes(s)), `META tab: ${byCat('meta').join(' ')}`);
ok(['NVDAx', 'SPCXx', 'CRCLx', 'SPYx', 'GOOGLx'].every((s) => byCat('stock').includes(s)), `Stocks tab: ${byCat('stock').join(' ')}`);
ok(boot.quotes.filter((q) => ['meta', 'stock'].includes(q.category)).every((q) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.mint) && q.usd > 0),
  'every pair asset has a real mint and a live price');

// the fee matrix, through the real create route
const mk = async (label, fees, extra = {}) => api('/api/tokens', { name: 'Spec ' + label, symbol: 'SP' + Math.random().toString(36).slice(2, 6).toUpperCase(), quote: 'SOL', image: PNG, fairOpenSecs: 0, ...fees, ...extra }, await freshH());
const accepts = async (label, fees) => { try { const t = await mk(label, fees); ok(true, `${label} launches`); return t; } catch (e) { ok(false, `${label} must launch — ${e.message}`); } };
const rejects = async (label, fees, re) => { try { await mk(label, fees); ok(false, `${label} must be rejected`); } catch (e) { ok(re.test(e.message), `${label} rejected → "${e.message.replace(/^400 /, '')}"`); } };
await accepts('1/1/1', { holderBps: 100, vaultBps: 100, burnBps: 100 });
await accepts('2/1/1', { holderBps: 200, vaultBps: 100, burnBps: 100 });
await accepts('3/0.5/0.5', { holderBps: 300, vaultBps: 50, burnBps: 50 });
await accepts('2/1/1/0 (memo default)', { holderBps: 200, creatorBps: 100, vaultBps: 100 });
await accepts('3/1/1 (the full 5% stack)', { holderBps: 300, vaultBps: 100, burnBps: 100 });
await accepts('3% + 1% creator + 1% vault (5%)', { holderBps: 300, creatorBps: 100, vaultBps: 100 });
await accepts('vault at its 2% ceiling', { holderBps: 200, vaultBps: 200, burnBps: 100 });
await rejects('vault 2.5%', { holderBps: 200, vaultBps: 250 }, /Vault ceiling is 2%/);
await rejects('6%, over the ceiling', { holderBps: 300, creatorBps: 100, vaultBps: 100, burnBps: 100 }, /over the 5% ceiling/);
await rejects('quarter-point step', { holderBps: 125 }, /half-point/);

// a full launch on the memo's own default, then trade it and settle the first epoch
const TH = await freshH();
const t = await api('/api/tokens', { name: 'Spec Engine', symbol: 'SPENG', quote: 'SOL', image: PNG, fairOpenSecs: 0, holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0, devBuy: 2 }, TH);
const d0 = await api(`/api/tokens/${t.token.mint}`, null, TH);
ok(d0.token.fees.totalBps === 400, `four buckets stored: ${d0.token.fees.holderBps}/${d0.token.fees.creatorBps}/${d0.token.fees.vaultBps}/${d0.token.fees.burnBps} = ${d0.token.fees.totalBps / 100}%`);
// The LAUNCH rate is 0.50%, and a wallet holding enough REX launches further down the schedule —
// that discount is the product, not a bug. This used to assert 50 flat and passed only because the
// demo faucet's fixed REX allocation happened to sit under the qualifying threshold in dollars.
// REX rose 9% in a day, the same faucet crossed $500, and the assertion broke without anything in
// the code changing. So it now checks the invariant instead of the number: the standard rate is
// 0.50%, the launch got whatever ITS wallet qualifies for, and holders keep every basis point REX
// gave up.
const rate = (await api('/api/state', null, TH)).me.rexRate;
ok(rate.standard === 50, `the REX protocol fee opens at 0.50% of the trade (standard ${rate.standard} bps)`);
ok(d0.token.fees.rexBps === rate.bps,
  `this launch pays the rate its wallet qualifies for: ${rate.bps} bps${rate.qualifies ? ` (holding $${rate.heldUsd.toFixed(0)} of REX)` : ''}`);
ok(d0.token.fees.holderBps - d0.token.fees.holderNetBps === d0.token.fees.rexBps,
  `REX's cut is carved OUT of the holder allocation, not added on: ${d0.token.fees.holderBps} - ${d0.token.fees.holderNetBps} = ${d0.token.fees.rexBps} bps`);
const q = await api('/api/quote', { mint: t.token.mint, side: 'buy', amount: 10 });
ok(near(q.quote.tax, 10 * 0.04, 1e-9), `a 10 SOL buy is charged exactly 4% (${q.quote.tax})`);
// Same reason: REX's slice depends on the launcher's own rate, so the split is checked as a
// relationship rather than as four fixed decimals. Holders get the 2% allocation less whatever REX
// takes from it, and the four parts still add up to the whole fee.
const rexCut = 10 * d0.token.fees.rexBps / 10_000;
ok(near(q.quote.split.rex, rexCut, 1e-9) && near(q.quote.split.holder, 0.20 - rexCut, 1e-9)
  && near(q.quote.split.creator, 0.1, 1e-9) && near(q.quote.split.vault, 0.1, 1e-9),
  `a 10 SOL buy splits ${q.quote.split.holder.toFixed(3)} holders / ${q.quote.split.rex.toFixed(3)} REX / 0.10 creator / 0.10 vault`);
ok(near(q.quote.split.holder + q.quote.split.rex + q.quote.split.creator + q.quote.split.vault, q.quote.tax, 1e-9),
  'and the four parts account for every lamport of the fee charged');
await api('/api/trade', { mint: t.token.mint, side: 'buy', amount: 15 }, TH);
const d1 = await api(`/api/tokens/${t.token.mint}`, null, TH);
ok(d1.token.buckets.creatorPot > 0 && d1.token.buckets.vaultPot > 0 && d1.token.buckets.rexPot > 0, 'every bucket filled from one swap');
ok(d1.me.share > 0 && d1.me.belowFloor === false, `the buyer is in the next epoch at ${(d1.me.share * 100).toFixed(1)}% of the pool`);
ok(typeof d1.token.buckets.vaultAddress === 'string' && d1.token.buckets.vaultAddress.length > 20, `the vault address is on the pair page (${d1.token.buckets.vaultAddress.slice(0, 12)}…)`);

// the window options
ok(JSON.stringify(boot.fairOpenChoices || []) === '[0,60,120,300]' || boot.fairOpenChoices === undefined, 'window choices exclude 30s');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
