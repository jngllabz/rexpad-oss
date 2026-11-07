// The endpoint list, and the day the failover had nowhere to fail over to.
//
// ⛔ ON 7 OCT PRODUCTION'S RPC KEY ANSWERED 401 TO EVERY METHOD — getHealth, getSlot, getBalance,
// all of them — while RPC_URL held exactly one entry. The machinery for surviving a dead endpoint
// was in place and useless, because a list of length one has nothing below it. The symptoms reached
// the team as "the burn panel doesn't update" and "I can't buy the coin I just launched".
//
//   node tools/rpc_fallback_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-rf-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'rf.sqlite';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const PUB = 'api.mainnet-beta.solana.com';
// ⛔ CONFIG IS READ ONCE AT IMPORT, so re-importing this module with a cache-busting query does NOT
// pick up a new RPC_URL — the first value sticks for the whole process. The list functions take the
// raw string instead, which is both testable and honest about where the value comes from.
process.env.RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=0123456789012345678901234567890123456';
const CH = await import('../lib/chain.mjs');

console.log('── ⛔ THE PUBLIC ENDPOINT IS ALWAYS LAST IN THE LIST, EVEN WHEN NOBODY LISTED IT');
{
  const hosts = CH.rpcHosts('https://mainnet.helius-rpc.com/?api-key=0123456789012345678901234567890123456');
  ok(hosts.length === 2, `one configured endpoint became ${hosts.length}`);
  ok(hosts[0] === 'mainnet.helius-rpc.com', 'the paid endpoint is still first, so it serves every call');
  ok(hosts[1] === PUB, 'and the free one sits behind it as somewhere to fall to');
}

console.log('\n── it is never added twice');
{
  const hosts = CH.rpcHosts(`https://paid.example.com/?api-key=k,https://${PUB}`);
  ok(hosts.filter((x) => x === PUB).length === 1, 'an operator who already listed it gets one copy');
  ok(hosts.length === 2, `list is ${hosts.join(' → ')}`);
}

console.log('\n── and with nothing configured at all, there is still an endpoint');
{
  ok(CH.rpcHosts('')[0] === PUB, 'an empty RPC_URL still yields a usable list');
  ok(CH.rpcEndpoints('').length === 1, 'of exactly one entry');
}

console.log('\n── ⛔ A REVOKED KEY IS SYNTACTICALLY PERFECT, SO THE PROBE ASKS INSTEAD OF INSPECTING');
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await CH.probeRpc();
  ok(r.ok === false && r.status === 401, 'a 401 is reported as not ok');
  ok(r.host === 'mainnet.helius-rpc.com' && !String(r.host).includes('api-key'),
    'with the HOST only — the full URL carries a key and must never be logged');
  ok(CH.rpcProbe().ok === false, 'and it is readable afterwards, which is what /api/health serves');
  globalThis.fetch = real;
}

console.log('\n── a 200 carrying an `error` member is still a refusal');
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32601, message: 'Method not found' } }) });
  const r = await CH.probeRpc();
  ok(r.ok === false, 'a provider that disables a method by answering 200 + error does not pass');
  globalThis.fetch = real;
}

console.log('\n── a healthy endpoint passes, and says so');
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: 371_000_000 }) });
  const r = await CH.probeRpc();
  ok(r.ok === true && r.status === 200, 'ok');
  ok(typeof r.at === 'number' && Date.now() - r.at < 5000, 'stamped with when it was asked');
  globalThis.fetch = real;
}

console.log('\n── an unreachable endpoint is a failure, not an exception');
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const r = await CH.probeRpc();
  ok(r.ok === false && r.status === 0, 'a network failure reports ok:false rather than throwing');
  globalThis.fetch = real;
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
