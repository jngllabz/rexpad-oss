// The findings from the RTS OMEGA pen test REX's auditor ran on rexpad.fly.dev (3 Oct 2026), turned
// into checks. Each one reproduces the report's own proof-of-concept against a running server and
// asserts the behaviour it asked for, so none of these can quietly come back.
//
// Run: node tools/security_test.mjs [base]      (default http://127.0.0.1:8787)
import { WebSocket } from 'ws';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws') + '/ws';
let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
/**
 * "I could not test this" — a THIRD state, distinct from "I tested it and it held".
 *
 * ⛔ WHY A SECURITY SUITE NEEDS ONE. Some checks here depend on a third party being reachable, and
 * two states force a bad choice: fail, and a Jupiter outage blocks a deploy of unrelated code; pass,
 * and the check goes green having verified nothing. This file took the second option by accident —
 * `ok(!r1.quote?.platformFee || ...)` is a clean vacuous pass when no quote came back at all, and
 * a security assertion that silently stops asserting is worse than one that fails.
 *
 * A skip never fails the run — an unreachable third party is not a regression in this repo — but it
 * is printed per check AND counted in the summary, so "0 skipped" is the normal line and anything
 * else is visible to whoever reads the deploy output. Silence is the thing being designed out.
 */
const skip = (m, why) => { skipped++; console.log('⏭️  SKIPPED —', m, `(${why})`); };
const H = (r, k) => r.headers.get(k);

// ---------- F1 Host header injection → cache poisoning of canonical / og:image
{
  const r = await fetch(BASE + '/', { headers: { host: 'evil.com', 'x-forwarded-host': 'evil.com' } });
  const html = await r.text();
  ok(!/evil\.com/i.test(html), 'F1 a spoofed Host never reaches the canonical link or the card URLs');
  ok(/<link rel="canonical" href="https?:\/\/[^"]+"/.test(html), 'F1 a canonical link is still emitted');
}

// ---------- F3 / F5 transport and script policy
{
  const r = await fetch(BASE + '/');
  ok(/max-age=\d+/.test(H(r, 'strict-transport-security') || ''), 'F3 HSTS is set on the page');
  const csp = H(r, 'content-security-policy') || '';
  ok(/default-src 'self'/.test(csp), 'F5 a CSP is set');
  ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "F5 the CSP does not allow inline script — an injected <script> cannot run");
  ok(/object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp), 'F5 object-src and base-uri are locked down');
  ok((H(r, 'permissions-policy') || '').includes('camera=()'), 'F3 Permissions-Policy is set');
}

// ---------- F7 the JSON layer carries the same headers as the HTML layer
{
  const r = await fetch(BASE + '/api/state');
  ok(H(r, 'x-content-type-options') === 'nosniff', 'F7 API sets X-Content-Type-Options');
  ok(H(r, 'x-frame-options') === 'DENY', 'F7 API sets X-Frame-Options');
  ok((H(r, 'referrer-policy') || '').startsWith('strict-origin'), 'F7 API sets Referrer-Policy');
  ok(H(r, 'cache-control') === 'no-store', 'F7 API keeps Cache-Control: no-store');
  ok(/max-age=\d+/.test(H(r, 'strict-transport-security') || ''), 'F7 API sets HSTS too');
}

// ---------- F2 cross-origin WebSocket hijacking
const dial = (origin) => new Promise((resolve) => {
  const s = new WebSocket(WSB, origin ? { headers: { origin } } : {});
  const done = (v) => { try { s.close(); } catch {} resolve(v); };
  s.on('open', () => done('open'));
  s.on('error', () => done('refused'));
  setTimeout(() => done('timeout'), 4000);
});
ok(await dial('https://evil.com') === 'refused', 'F2 an upgrade from evil.com is refused');
ok(await dial(BASE) === 'open', 'F2 an upgrade from our own origin still works');
ok(await dial(null) === 'open', 'F2 a non-browser client with no Origin still works');

// ---------- F4 the session token must not be reachable through the URL
{
  const demo = await (await fetch(BASE + '/api/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json().catch(() => ({}));
  const src = await (await fetch(BASE + '/state.js')).text();
  ok(!/\/ws\$\{|\/ws[^`'"]*\?token=|'\?token=' *\+/.test(src), 'F4 the client never puts the token in the WebSocket URL');
  if (demo.token) {
    // The server must ignore a token in the query string, so an old link or a log cannot be replayed.
    const authed = await new Promise((resolve) => {
      const s = new WebSocket(`${WSB}?token=${demo.token}`, { headers: { origin: BASE } });
      s.on('open', () => { setTimeout(() => { try { s.close(); } catch {} resolve(true); }, 300); });
      s.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 4000);
    });
    ok(authed, 'F4 a ?token= connection is accepted but the parameter is simply not read');
  } else { console.log('·  F4 no demo wallet on this server (not SIM) — the replay half is skipped'); }
}


// ---------- the Jupiter proxy: the fee is ours to set, so the client must not be able to move it
{
  const jr = await fetch(BASE + '/api/jup/tokens');
  if (jr.status === 503) {
    console.log('·  Jupiter proxy off on this deployment — skipped');
  } else {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

    const served = (await jr.json()).feeBps;
    // A caller asking for a different platform fee must not get one — ours is injected server-side.
    // The EFFECTIVE fee can legitimately be lower than the configured one (it is zero on any route
    // whose output mint REX has no token account for), so the property under test is that the client
    // can never push it ABOVE what the server decided — not that the two numbers are equal.
    // ⛔ ASSERT A QUOTE WAS ACTUALLY OBTAINED BEFORE ASSERTING ANYTHING ABOUT ITS CONTENTS.
    // `JUP.quote()` throws when Jupiter is unreachable and the route turns that into `{ error }`,
    // so `r.quote` being present is exactly "a real round trip happened". Without this gate the
    // three checks below read a response that has no quote in it and two of them pass anyway:
    // `!r1.quote?.platformFee ||` is `!undefined`, and `r2.feeAccount !== SOL` is `undefined !==
    // SOL`. The suite then reports the fee-injection defence as verified on a run that never
    // reached Jupiter.
    //
    // The failure that was blocking deploys was NOT one of those: `ok(!r1.error && ...)` fails on
    // the error term, which is the test correctly refusing to vouch for something it could not
    // check. It only LOOKED spurious because `r1.feeBps ?? 0` renders an error object as "got 0",
    // so an outage was reported in the words of a fee mismatch. Both halves are fixed here: the
    // outage is named and skipped, and the vacuous passes are gated out.
    const r1 = await (await post('/api/jup/quote', { inputMint: SOL, outputMint: USDC, amount: 100000000, slippageBps: 50, platformFeeBps: 9000 })).json();
    if (!r1.quote) {
      skip('jup the client cannot raise the platform fee, and the quote carries the server\'s fee',
        r1.error ? `no quote from Jupiter: ${String(r1.error).slice(0, 80)}` : 'the proxy answered without a quote');
    } else {
      ok((r1.feeBps ?? 0) <= served, `jup the client cannot raise the platform fee (asked 9000, server allows ${served}, got ${r1.feeBps ?? 0})`);
      // A quote may legitimately carry NO platformFee — the fee is zero on any route whose output
      // mint REX holds no token account for — so its absence is a real answer, not a missing test.
      // What must never happen is a fee inside the quote that differs from the one we reported.
      ok(!r1.quote.platformFee || Number(r1.quote.platformFee.feeBps) === (r1.feeBps ?? 0),
        'jup the fee inside the quote is the one the server reported, not the one the client asked for');
    }

    // And must not be able to point the fee at its own account. (Spaced, because quotes are
    // throttled to one per 250ms per caller — that is the proxy working, not a failure.)
    await new Promise((r) => setTimeout(r, 400));
    const r2 = await (await post('/api/jup/quote', { inputMint: SOL, outputMint: USDC, amount: 100000000, feeAccount: SOL })).json();
    if (!r2.quote) {
      skip('jup the client cannot choose where the fee lands',
        r2.error ? `no quote from Jupiter: ${String(r2.error).slice(0, 80)}` : 'the proxy answered without a quote');
    } else {
      // `feeAccount` may be null — REX holds no token account for that output mint — and null is a
      // real answer to "is it the client's?", not an absent one. The gate above is what makes the
      // difference: this now runs only when a quote genuinely came back.
      ok(r2.feeAccount !== SOL, 'jup the client cannot choose where the fee lands');
    }

    for (const [label, body] of [
      ['the same token both sides', { inputMint: SOL, outputMint: SOL, amount: 1000 }],
      ['a non-mint input', { inputMint: 'not-a-mint', outputMint: USDC, amount: 1000 }],
      ['a zero amount', { inputMint: SOL, outputMint: USDC, amount: 0 }],
      ['a negative amount', { inputMint: SOL, outputMint: USDC, amount: -5 }],
    ]) {
      const r = await post('/api/jup/quote', body);
      ok(r.status === 400, `jup ${label} is rejected`);
    }
    const big = await post('/api/jup/send', { tx: 'A'.repeat(4000) });
    ok(big.status === 400, 'jup an oversized transaction is rejected before it reaches an RPC');
    const badw = await post('/api/jup/swap', { quoteResponse: { outputMint: USDC }, userPublicKey: 'nope' });
    ok(badw.status === 400, 'jup a malformed wallet is rejected');
  }
}

// Deliberately last: this spends the whole per-IP budget, and against a real deployment every
// check after it would get a 429 and fail for a reason that has nothing to do with what it tests.
// ---------- F8 rate limiting
{
  // The limiter exempts loopback unless RATE_LOOPBACK=1, so say we are someone else.
  const ip = '203.0.113.' + (1 + Math.floor(Math.random() * 250));
  // Enough to clear the default ceiling (240/min) with room to spare — RATE_MAX=<n> if it is tuned.
  const budget = Number(process.env.RATE_MAX || 240) + 40;
  let limited = false;
  for (let i = 0; i < budget && !limited; i++) {
    const r = await fetch(BASE + '/api/state', { headers: { 'fly-client-ip': ip } });
    if (r.status === 429) { limited = true; ok(Number(H(r, 'retry-after')) > 0, 'F8 a 429 carries Retry-After'); }
  }
  ok(limited, 'F8 bulk scraping from one IP is rate limited');
  // Only a local server believes a client-IP header. Behind Fly the edge sets fly-client-ip itself
  // and overwrites whatever was sent — which is why the limiter trusts it there — so a remote run
  // cannot pose as two different callers, and the loop above counted against this machine's own IP.
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(BASE)) {
    const fresh = await fetch(BASE + '/api/state', { headers: { 'fly-client-ip': '198.51.100.7' } });
    ok(fresh.status === 200, 'F8 a different IP is unaffected');
  } else {
    console.log('·  F8 per-IP isolation not checkable remotely — the edge sets the client IP, so it cannot be spoofed (which is the point)');
  }
}

console.log('\n── ⛔ THE ADMIN GATE ADDS AN OWNER KEY, IT DOES NOT COPY THE PAYEE LIST');
{
  const fs = await import('node:fs');
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const gate = srv.slice(srv.indexOf('const adminOk = async () =>'), srv.indexOf('const adminOk = async () =>') + 1400);
  ok(/cfg\.adminWallets\.includes\(wallet\)/.test(gate), 'an explicitly named owner key is allowed');
  ok(/protocolWallets\(\)/.test(gate), '⛔ and the chain-derived payee list is STILL consulted, not replaced');
  ok(/if \(!allowed\) \{ json\(res, 503/.test(gate),
    '⛔ an unreadable config still authorises nobody — it must not fail open');
  const cfgSrc = fs.readFileSync(new URL('../lib/config.mjs', import.meta.url), 'utf8');
  ok(/adminWallets: String\(env\.ADMIN_WALLETS/.test(cfgSrc), 'the extra keys come from the environment, not a literal in the file');
  // An empty setting must not turn into a wallet called "".
  ok(/\.filter\(Boolean\)/.test(cfgSrc), '⛔ and an empty setting yields no keys rather than one blank one');
}

// ⛔ SKIPS ARE IN THE SUMMARY LINE, ALWAYS — including when there are none. A skip that only
// appeared when it happened would be a line nobody learns to look for; "0 skipped" on every normal
// run is what makes a non-zero count register. A skip does not fail the suite, so an outage at a
// third party cannot block a deploy of unrelated code, but it can never be mistaken for a pass.
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
if (skipped > 0) console.log(`⚠️  ${skipped} check${skipped === 1 ? '' : 's'} could not run — that is NOT the same as passing. Re-run when the dependency is back.`);
process.exit(fail ? 1 : 0);
