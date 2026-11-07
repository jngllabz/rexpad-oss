// Throws junk at every endpoint of a running server; fails on any 5xx or a dropped connection. Run: node tools/api_fuzz.mjs [base]
const BASE = process.argv[2] || 'http://localhost:5300';
let bad = 0, n = 0;
async function hit(method, path, body, headers = {}) {
  n++;
  try {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    if (r.status >= 500) { bad++; console.log('❌ 5xx', method, path, r.status, (await r.text()).slice(0, 120)); }
    return r;
  } catch (e) { bad++; console.log('❌ dropped', method, path, e.message); return null; }
}
const junk = [null, 0, -1, 1e308, 'x', '', [], {}, { a: 1 }, true, '1e999', 'NaN', '{"unterminated', String.fromCharCode(0), 'A'.repeat(50_000)];
// auth (demo wallet, SIM only)
const demo = await (await hit('POST', '/api/auth/demo', {})).json().catch(() => ({}));
const tok = demo.token; const H = tok ? { authorization: 'Bearer ' + tok } : {};
const tokens = (await (await hit('GET', '/api/tokens?limit=5')).json()).tokens; const mint = tokens[0]?.mint;
for (const j of junk) {
  await hit('POST', '/api/auth/nonce', { wallet: j }); await hit('POST', '/api/auth/verify', { wallet: j, nonce: j, signature: j });
  await hit('POST', '/api/quote', { mint, side: j, amount: j }); await hit('POST', '/api/quote', { mint: j, side: 'buy', amount: 1 });
  await hit('POST', '/api/trade', { mint, side: 'buy', amount: j, slippageBps: j }, H); await hit('POST', '/api/trade', { mint: j, side: 'sell', amount: 1 }, H);
  await hit('POST', '/api/fairopen/bid', { mint: j, amount: j }, H); await hit('POST', '/api/fairopen/cancel', { mint: j }, H);
  await hit('POST', '/api/chat', { mint: j, text: j }, H); await hit('POST', '/api/me/name', { name: j }, H);
  await hit('POST', '/api/tokens', { name: j, symbol: j, quote: j, taxBps: j, fairOpenSecs: j, devBuy: j, image: j }, H);
  await hit('POST', '/api/tokens', typeof j === 'string' ? j : JSON.stringify(j), H);
}
await hit('GET', '/api/tokens?sort=' + encodeURIComponent("' OR 1=1 --") + '&q=' + encodeURIComponent('%\'"<script>') + '&quote=ZZZ&status=nope&limit=-5');
await hit('GET', '/api/tokens/notamint'); await hit('GET', '/api/tokens/' + 'A'.repeat(44) + '/candles?tf=99y'); await hit('GET', `/api/tokens/${mint}/candles?tf=`);
await hit('GET', '/api/profile/x'); await hit('GET', '/api/profile/' + 'z'.repeat(44)); await hit('GET', '/api/me'); await hit('GET', '/api/me', undefined, { authorization: 'Bearer nope' });
await hit('GET', '/api/../server.mjs'); await hit('GET', '/img/../server.mjs'); await hit('GET', '/img/%2e%2e/server.mjs'); await hit('GET', '/..%2f..%2fetc/passwd'); await hit('GET', '/%00'); await hit('GET', '/' + 'a'.repeat(5000));
await hit('POST', '/api/tokens', { name: 'X', symbol: 'X', quote: 'SOL', image: 'data:image/png;base64,' + 'A'.repeat(3_000_000) }, H);
await hit('POST', '/api/trade', '{"mint":' + '['.repeat(20000), H);
await hit('PUT', '/api/state'); await hit('DELETE', '/api/tokens'); await hit('OPTIONS', '/api/health'); await hit('HEAD', '/');
// hammer: 40 rapid trades — expect 429s, never 5xx
if (mint) await Promise.all(Array.from({ length: 40 }, () => hit('POST', '/api/trade', { mint, side: 'buy', amount: 0.01 }, H)));
const health = await (await hit('GET', '/api/health')).json().catch(() => null);
console.log(`\n${n} requests · ${bad} failures · health ${health ? 'ok' : 'DOWN'}`);
process.exit(bad || !health ? 1 : 0);
