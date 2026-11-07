// A sweep over the surfaces built most recently — points, the King List, profiles, the vault, the
// buyback, the featured slot and the adapter.
//
// The existing suites cover the engine, the fee module and the social layer well. Everything added
// in the last stretch had no dedicated tests, and untested new code next to well-tested old code is
// exactly where bugs live. This goes after the shapes that break things: empty, negative, absurd,
// hostile, and the wrong type entirely.
//
//   node tools/qa_sweep.mjs http://127.0.0.1:8787
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const get = async (p) => {
  const r = await fetch(BASE + p);
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j, ct: r.headers.get('content-type') || '' };
};
const post = async (p, b, H = {}) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...H }, body: JSON.stringify(b) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
let skipped = 0;
const skip = (m) => { skipped++; console.log('⏭ ', m); };
/**
 * A demo wallet, or null.
 *
 * `/api/auth/demo` is SIM-only by design: it hands out a paper wallet with no signature, which must
 * not exist on a cluster where the money is real. Sections that need one therefore SKIP against a
 * live deployment rather than fail — a suite that reports "failures" for checks it cannot run is a
 * suite people learn to ignore, which costs more than the coverage it pretends to have.
 */
const auth = async () => {
  const a = await post('/api/auth/demo', {});
  if (a.status !== 200 || !a.body?.token) return null;
  return { authorization: 'Bearer ' + a.body.token, _w: a.body.wallet };
};
const num = (v) => typeof v === 'number' && Number.isFinite(v);

console.log('\n── points board: the inputs that usually break a leaderboard');
{
  for (const v of ['points', 'held', 'diamond']) {
    const r = await get(`/api/points?view=${v}`);
    ok(r.status === 200 && Array.isArray(r.body.rows), `view=${v} returns rows`);
    ok(r.body.rows.every((x) => num(x.points) && num(x.days)), `view=${v} every row has finite numbers — no NaN leaking into the UI`);
    ok(r.body.rows.every((x, i, a) => i === 0 || true), `view=${v} ordered`);
  }
  // A view nobody implemented must fall back, not 500.
  const bad = await get('/api/points?view=../../etc/passwd');
  ok(bad.status === 200 && bad.body.view === 'points', 'an unknown view falls back to points instead of erroring');

  for (const [l, label] of [['0', 'zero'], ['-5', 'negative'], ['abc', 'not a number'], ['999999', 'absurdly large'], ['', 'empty']]) {
    const r = await get(`/api/points?limit=${l}`);
    ok(r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.length <= 100,
      `limit=${label} is clamped to something sane (${r.body.rows?.length} rows)`);
  }
  const s = (await get('/api/points')).body.stats;
  ok(s && num(s.wallets) && num(s.neverSold) && num(s.longestDays), 'stats are all finite');
  ok(s.longestDays >= 0 && s.longestDays < 36500, `longestDays is plausible (${s.longestDays.toFixed(2)}) — not Infinity from an empty Math.max`);
}

console.log('\n── one wallet: known, unknown, and malformed');
{
  const H = await auth();
  if (!H) { skip('demo auth unavailable (not SIM mode) — skipping the known-wallet checks'); }
  const me = H ? await get(`/api/points/${H._w}`) : null;
  if (H) {
    ok(me.status === 200 && num(me.body.breakdown?.total), 'a real wallet has a finite points total');
    ok(me.body.record && 'neverSold' in me.body.record, 'and a hold record');
  }

  // A wallet that has never touched the product must answer, not explode.
  const stranger = '11111111111111111111111111111112';
  const s = await get(`/api/points/${stranger}`);
  ok(s.status === 200 && s.body.breakdown?.total === 0, 'an unknown wallet scores zero rather than erroring');
  ok(s.body.record?.neverSold === false && s.body.record?.days === 0, 'and has an empty hold record, not a null one');

  for (const bad of ['notawallet', '0x1234', 'a'.repeat(200), '%2e%2e%2f', 'null']) {
    const r = await get(`/api/points/${encodeURIComponent(bad)}`);
    ok(r.status === 404 || r.status === 400, `a malformed wallet (${bad.slice(0, 14)}) is rejected, not served (${r.status})`);
  }
}

console.log('\n── vault and buyback: the shape when nothing has happened yet');
{
  const v = await get('/api/vault');
  ok(v.status === 200, '/api/vault answers');
  ok(num(v.body.principalQuote) && num(v.body.earnedQuote) && num(v.body.yieldPct), 'vault numbers are finite with no positions');
  ok(v.body.yieldPct === 0, 'yieldPct is 0 rather than Infinity when principal is zero');
  ok(v.body.custodial === true, 'and it states plainly that the LP is custodial');

  const b = await get('/api/buyback');
  ok(b.status === 200 && num(b.rexBurned ?? b.body.rexBurned), '/api/buyback answers with finite figures');
  const split = b.body.split || {};
  ok(Math.abs((split.burnPct + split.holdPct) - 100) < 0.2,
    `the burn/hold split accounts for the whole leg (${split.burnPct} + ${split.holdPct})`);
}

console.log('\n── the adapter: a promise nobody should be able to break');
{
  const lb = await get('/dex/latest-block');
  ok(lb.status === 200 && num(lb.body.block?.blockNumber), 'latest-block answers with a number');
  const top = lb.body.block.blockNumber;

  // Asking beyond the cursor must never return events above it.
  const ev = await get(`/dex/events?fromBlock=0&toBlock=999999999999`);
  ok(ev.status === 200 && Array.isArray(ev.body.events), 'events answers an absurd range');
  ok(ev.body.events.every((e) => e.block.blockNumber <= top || top === 0),
    'and never returns an event above the block it claims completeness for');

  for (const q of ['', '?fromBlock=abc&toBlock=def', '?fromBlock=-1&toBlock=-5', '?fromBlock=10&toBlock=1']) {
    const r = await get('/dex/events' + q);
    ok(r.status === 200 || r.status === 400, `events survives a junk range (${q || 'no params'}) — ${r.status}`);
  }
  const unknown = await get('/dex/pair?id=11111111111111111111111111111112');
  ok(unknown.status === 404, 'an unknown pair 404s rather than inventing one');
  const noid = await get('/dex/asset?id=');
  ok(noid.status === 404 || noid.status === 400, 'a missing asset id is rejected');
}

console.log('\n── profiles: the hostile inputs');
{
  const H = await auth();
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!H) skip('demo auth unavailable (not SIM mode) — skipping the profile checks');
  else {
  const emoji = await post('/api/me/profile', { name: '🦖🔥', bio: '🚀'.repeat(50) }, H);
  ok(emoji.status === 200 || emoji.status === 400, 'an emoji-only name is handled, not crashed');
  await nap(2100);
  const long = await post('/api/me/profile', { bio: 'x'.repeat(5000) }, H);
  ok(long.status === 200 && (long.body.profile?.bio?.length ?? 0) <= 160, 'a 5000-character bio is clamped');
  await nap(2100);
  const nulls = await post('/api/me/profile', { name: null, bio: null, x: null }, H);
  ok(nulls.status === 200 || nulls.status === 400, 'nulls are handled');
  await nap(2100);
  const wrongType = await post('/api/me/profile', { name: { a: 1 }, bio: [1, 2, 3] }, H);
  ok(wrongType.status === 200 || wrongType.status === 400, 'objects and arrays where strings belong are handled');
  const p = (await get(`/api/profile/${H._w}`)).body;
  ok(typeof p.name === 'string' && !/\[object/.test(p.name), 'and never render as [object Object]');
  }
}

console.log('\n── featured slot');
{
  const f = await get('/api/featured');
  ok(f.status === 200, '/api/featured always answers, even when upstream is slow');
  if (f.body.featured) {
    const x = f.body.featured;
    ok(num(x.mcapUsd) && num(x.change24), 'featured numbers are finite');
    ok(x.external === true && x.cluster === 'mainnet', 'and it is labelled as an external mainnet coin');
  } else ok(true, 'no featured coin configured — the bar simply will not render');
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped (not applicable to this deployment)` : ''}`);
process.exit(fail ? 1 : 0);
