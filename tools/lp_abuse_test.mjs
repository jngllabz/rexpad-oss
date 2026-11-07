// Can the new surfaces be used to take the site down, or to move the wrong amount of money?
//
// ⛔ ALL FOUR OF THESE SHIPPED. They were found by going back over the same day's work rather than
// by anything failing, which is the only reason they were cheap:
//
//  1. /api/lp/pools took ANY mint, unauthenticated and unthrottled, and each miss ran a
//     getProgramAccounts scan. A loop over random base58 strings is this morning's outage offered
//     as a feature.
//  2. /api/lp/positions was the same with getPositionsByUser.
//  3. The amount box converted with a hardcoded 1e6. A SOL-paired pool is 9 decimals, so "1 SOL"
//     became a thousandth of it; an xStock pair is 8, so a hundredth.
//  4. Every swap build gained an uncached getAccountInfo on the base mint, on an RPC that ran out
//     of allowance twice today — and swallowed a failed check as "not hooked", which builds a swap
//     the chain will refuse.
//
//   node tools/lp_abuse_test.mjs [base-url]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-abuse-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'abuse.sqlite';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };

console.log('── an unknown mint cannot start a program scan');
{
  const stranger = Keypair.generate().publicKey.toBase58();
  const r = await get('/api/lp/pools?mint=' + stranger);
  ok(r.status === 404, `a mint this site does not list is refused (${r.status})`);
  ok(!Array.isArray(r.body.pools), 'and no scan result comes back');

  const bad = await get('/api/lp/pools?mint=not-a-mint');
  ok(bad.status === 400, 'a malformed mint is refused before anything else happens');
}

console.log('\n── the scanning routes are rate limited per caller');
{
  // Hammer with the SAME shape a real page uses, which is the only thing a limit has to survive.
  const who = Keypair.generate().publicKey.toBase58();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await get('/api/lp/positions?wallet=' + who)).status);
  ok(codes.includes(429), `repeated position scans are throttled (${codes.join(',')})`);
}

console.log('\n── the amount box never assumes six decimals');
{
  const pages = fs.readFileSync('public/pages.js', 'utf8');
  const lp = pages.slice(pages.indexOf('export async function liquidity'));
  ok(!/Number\(amount\) \* 1e6|Number\(n\) \* 1e6|n \* 1e6/.test(lp),
    'the liquidity page contains no hardcoded 1e6 conversion');
  ok(/tokenBDecimals/.test(lp), 'it reads the pool\'s own decimals instead');
  // ⛔ And it must REFUSE rather than guess when they are unknown — this is the step that moves money.
  ok(/decimals, so the amount cannot be converted safely/.test(lp),
    'and refuses to convert at all when the decimals could not be read');
}

console.log('\n── the swap path does not re-read the mint on every trade');
{
  const met = fs.readFileSync('lib/meteora.mjs', 'utf8');
  ok(/hookCache/.test(met), 'the hook check is cached per mint');
  ok(!/hookOfMint\(conn, baseMint\)\.catch\(/.test(met),
    'a failed hook check is not swallowed into "not hooked"');
  ok(/could not check whether this coin has transfer rules/.test(met),
    'it refuses in words a trader can act on');
}

console.log('\n── a rate limit keyed on a string the caller chose is not a rate limit');
{
  // ⛔ EVERYTHING UNDER /api/chain/ TAKES ITS WALLET FROM `body.wallet`. That is sound for safety —
  // a transaction built for somebody else's key is useless without their signature — and useless
  // for rate limiting: `throttle('faucet', w, 60_000)` means one faucet per wallet per minute, and
  // changing the string buys another one immediately. Every tx builder behind it costs RPC reads,
  // which is real money on a metered endpoint.
  const srv = fs.readFileSync('server.mjs', 'utf8');
  const chain = srv.slice(srv.indexOf("if (p.startsWith('/api/chain/'))"), srv.indexOf("// Recipes"));
  const bare = [...chain.matchAll(/throttle\('([a-z]+)', w,/g)].map((m) => m[1]);
  ok(bare.length === 0, `no throttle in the chain block is keyed on the claimed wallet alone${bare.length ? ' — FOUND: ' + bare.join(', ') : ''}`);
  ok(/function throttled\(/.test(srv), 'there is a helper that applies both a wallet and an IP window');
  ok(/throttled\('faucet'/.test(chain), 'and the faucet — the one that hands out real value — uses it');
}

console.log('\n── a missing querystring number is absent, not zero');
{
  // ⛔ Number(null) IS 0. `Number.isFinite(Math.floor(Number(null)))` is therefore TRUE, so a route
  // validating an id this way answers for id 0 rather than rejecting a request that omitted it.
  const srv = fs.readFileSync('server.mjs', 'utf8');
  const snap = srv.slice(srv.indexOf("p === '/api/points/snapshot'"), srv.indexOf("p === '/api/points/snapshot'") + 700);
  ok(/rawEpoch === null/.test(snap), 'the snapshot route checks the raw value before converting it');
}

console.log('\n── the column migration has no duplicate table keys');
{
  // ⛔ A SECOND `tokens:` KEY IN THE SAME OBJECT LITERAL SILENTLY REPLACES THE FIRST. Adding
  // hook_program as its own entry dropped every column the original declared, and the server died
  // on boot with "table tokens has no column named reward_mode". JavaScript gives no warning, the
  // file still parses, and nothing fails until a fresh database is created — which on this project
  // means the deploy's own test server, and otherwise would have meant production.
  const src = fs.readFileSync('lib/db.mjs', 'utf8');
  const block = src.slice(src.indexOf('for (const [table, defs] of Object.entries({'), src.indexOf('})) {\n  const have'));
  const keys = [...block.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok(keys.length > 0, `the migration map was found (${keys.length} tables)`);
  ok(dupes.length === 0, `no table is declared twice${dupes.length ? ' — DUPLICATED: ' + [...new Set(dupes)].join(', ') : ''}`);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
