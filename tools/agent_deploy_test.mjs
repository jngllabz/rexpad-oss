// ⛔ "AI AGENTS BEING ABLE TO DEPLOY" — Elio, 11 Oct, one of two features he asked to be live.
//
// Nothing had to be built: the whole launch flow was already reachable over HTTP, because the
// browser is just another HTTP client. What was missing is that nobody could TELL — there was no
// documentation, no reference client, and no test proving a headless wallet could even sign in.
// A capability nobody can discover is indistinguishable from one that does not exist.
//
//   node tools/agent_deploy_test.mjs [base-url]
import fs from 'node:fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

let TOKEN = null;
const api = async (p, b) => {
  const r = await fetch(BASE + p, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
  let j = null; try { j = await r.json(); } catch { /* not every error is JSON */ }
  return { ok: r.ok, status: r.status, j };
};

console.log('── a wallet with no browser can prove who it is');
const kp = Keypair.generate(), ME = kp.publicKey.toBase58();
{
  const n = await api('/api/auth/nonce', { wallet: ME });
  ok(n.ok && n.j?.nonce && n.j?.message, 'the server issues a nonce and the message to sign');
  ok(/Wallet:/.test(n.j?.message || ''), 'and the message names the wallet, so it cannot be replayed for another');

  const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.j.message), kp.secretKey));
  const v = await api('/api/auth/verify', { wallet: ME, nonce: n.j.nonce, signature: sig });
  ok(v.ok && v.j?.token, 'a detached ed25519 signature is accepted — no browser, no extension');
  TOKEN = v.j?.token;

  const me = await api('/api/me');
  ok(me.ok && me.j?.wallet === ME, 'and the token authenticates as that wallet');
}

console.log('\n── ⛔ AND A WRONG SIGNATURE IS NOT');
{
  const other = Keypair.generate();
  const n = await api('/api/auth/nonce', { wallet: ME });
  // Signed by someone else entirely, for this wallet's message.
  const bad = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.j.message), other.secretKey));
  const v = await api('/api/auth/verify', { wallet: ME, nonce: n.j.nonce, signature: bad });
  ok(!v.ok, `another key's signature is refused (${v.status})`);
  const v2 = await api('/api/auth/verify', { wallet: ME, nonce: 'not-the-nonce', signature: bad });
  ok(!v2.ok, 'and so is a made-up nonce');
}

console.log('\n── everything an agent needs to choose a pair is in one call');
{
  const st = await api('/api/state');
  ok(st.ok && Array.isArray(st.j?.quotes) && st.j.quotes.length > 0, `${st.j?.quotes?.length} pairs listed`);
  const q = st.j.quotes[0];
  ok(q.symbol && q.mint && Number.isInteger(q.decimals),
    'each carries symbol, mint and decimals — an agent must not guess decimals to size a dev buy');
  ok('unavailable' in q, '⛔ and whether it can be launched against at all, before anything is signed');
}

console.log('\n── the reference client exists and does not ask for the key');
{
  const src = fs.readFileSync(new URL('./agent_launch.mjs', import.meta.url), 'utf8');
  ok(/AGENT_KEY/.test(src), 'it takes the key from the environment');
  ok(/nacl\.sign\.detached/.test(src), 'signs the nonce locally');
  ok(/\/api\/chain\/send/.test(src), 'and sends transactions it signed itself');
  ok(!/privateKey|secret.*=.*await api|post.*secret/i.test(src), '⛔ and never transmits the key anywhere');
  ok(/10 \*\* quote\.decimals/.test(src), '⛔ the dev buy is scaled by the PAIR\'s decimals, not a constant');
  ok(/quote\.unavailable/.test(src), 'it refuses a blocked pair before building');
  ok(/partialSign\(k\)|tx\.sign\(\[kp/.test(src), 'and signs each step with that step\'s own co-signers');
}

console.log('\n── the documentation is served, and is not an app that has to boot');
{
  const r = await fetch(BASE + '/developers');
  const html = await r.text();
  ok(r.ok, `/developers answers ${r.status}`);
  ok(/auth\/nonce/.test(html) && /auth\/verify/.test(html), 'it documents the sign-in handshake');
  ok(/dbc\/build/.test(html) && /dbc\/confirm/.test(html), 'and the build/confirm flow');
  ok(/agent_launch\.mjs/.test(html), 'and points at the runnable example');
  ok(/key never leaves the agent/i.test(html), '⛔ and says plainly that the server never holds keys');
  ok(!/<script/i.test(html), '⛔ no script tag — a docs page that needs JS is down when you most need it');
  ok(/decimals|base units/i.test(html), 'it warns about the units a dev buy is denominated in');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
