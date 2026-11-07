// Proves a SOL-quoted launch works for a wallet that holds ONLY native SOL — no wrapped SOL, no
// token account. That is every real user, and before the wrap/unwrap work it would have failed on
// the first bid with an insufficient-funds error from someone who plainly had the funds.
//
//   BASE=http://127.0.0.1:8788 node tools/devnet_sol_pair.mjs
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const conn = new Connection(process.env.RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const api = async (p, body) => {
  const r = await fetch(BASE + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${p} → ${r.status} ${j.error || ''}`); return j;
};
const sign = async (b64, kp) => { const t = Transaction.from(Buffer.from(b64, 'base64')); t.partialSign(kp); return (await api('/api/chain/send', { tx: t.serialize().toString('base64') })).signature; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const w = Keypair.generate();
console.log('wallet', w.publicKey.toBase58(), '— native SOL only, no token accounts\n');
const f = await api('/api/chain/faucet', { wallet: w.publicKey.toBase58() });
console.log(`faucet ${f.sol} SOL`);
await sleep(2500);

const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, true);
ok(!(await conn.getAccountInfo(wsol)), 'the wallet starts with NO wrapped-SOL account — the case that used to fail');

const st = await api('/api/state');
const sol = st.quotes.find((q) => q.symbol === 'SOL');
ok(!!sol, 'SOL is offered as a pair');

const raiseTarget = Math.floor(85.0054 * 1e9);
const built = await api('/api/chain/build/create', {
  wallet: w.publicKey.toBase58(), quoteMint: sol.mint, raiseTarget, vQuote0: Math.floor(raiseTarget * 30 / 85.0054),
  holderBps: 100, creatorBps: 50, vaultBps: 50, burnBps: 0, buybackBps: 0, fairOpenSecs: 60,
});
await api('/api/chain/meta', { wallet: w.publicKey.toBase58(), mint: built.mint, name: 'SOL Pair Test', symbol: 'SOLPAIR', description: 'wrap/unwrap check', image: PNG });
await sign(built.tx, w);
ok(true, `launched against SOL · ${built.mint.slice(0, 8)}…`);

console.log('\nbidding 0.01 SOL from a wallet with no wSOL account…');
const bid = await api('/api/chain/build/commit', { wallet: w.publicKey.toBase58(), mint: built.mint, amount: 0.01 * LAMPORTS_PER_SOL });
await sign(bid.tx, w);
await sleep(3000);
const me = await api(`/api/chain/me?mint=${built.mint}&wallet=${w.publicKey.toBase58()}`);
ok(Number(me.commitment?.amount || 0) === 0.01 * LAMPORTS_PER_SOL, `the bid escrowed ${Number(me.commitment?.amount || 0) / LAMPORTS_PER_SOL} SOL — wrapping happened inside the same transaction`);

console.log('\nwaiting for the bell…');
let status = '';
for (let i = 0; i < 30; i++) {
  await sleep(5000);
  const l = (await api(`/api/chain/launch?mint=${built.mint}`)).launch;
  status = typeof l.status === 'string' ? l.status : Object.keys(l.status)[0];
  if (status === 'live' || status === 'graduated') break;
}
ok(status === 'live' || status === 'graduated', `cleared → ${status}`);

const cl = await api('/api/chain/build/claim-fairopen', { wallet: w.publicKey.toBase58(), mint: built.mint });
await sign(cl.tx, w);
await sleep(3000);
ok(!(await conn.getAccountInfo(wsol)), 'after the claim the wrapped-SOL account is CLOSED — the refund came back as spendable SOL, not as a wrapper');

const before = await conn.getBalance(w.publicKey);
const buy = await api('/api/chain/build/buy', { wallet: w.publicKey.toBase58(), mint: built.mint, quoteIn: 0.005 * LAMPORTS_PER_SOL });
await sign(buy.tx, w);
await sleep(3000);
const pos = (await api(`/api/chain/me?mint=${built.mint}&wallet=${w.publicKey.toBase58()}`)).position;
ok(Number(pos?.amount || 0) > 0, `bought on the curve straight from native SOL — position ${Number(pos?.amount || 0) / 1e6} tokens`);
ok(!(await conn.getAccountInfo(wsol)), 'and the wrapper is closed again afterwards');

const sell = await api('/api/chain/build/sell', { wallet: w.publicKey.toBase58(), mint: built.mint, tokensIn: Math.floor(Number(pos.amount) / 2) });
await sign(sell.tx, w);
await sleep(3000);
const after = await conn.getBalance(w.publicKey);
ok(!(await conn.getAccountInfo(wsol)), 'a sell pays out as native SOL too — no wrapper left behind');
console.log(`\nwallet SOL ${(before / LAMPORTS_PER_SOL).toFixed(5)} → ${(after / LAMPORTS_PER_SOL).toFixed(5)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
