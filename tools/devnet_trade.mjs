// Carries the launch from the previous step all the way through: bid into the Fair Open, let the
// crank ring the bell, claim the fill, then buy and sell on the curve. Everything a first user does.
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const MINT = process.argv[2];
if (!MINT) { console.error('usage: node tools/devnet_trade.mjs <mint>'); process.exit(1); }
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const api = async (p, body) => {
  const r = await fetch(BASE + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${p} → ${r.status} ${j.error || ''}`); return j;
};
const signSend = async (b64, kp) => { const tx = Transaction.from(Buffer.from(b64, 'base64')); tx.partialSign(kp); return (await api('/api/chain/send', { tx: tx.serialize().toString('base64') })).signature; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const w = Keypair.generate();
console.log('bidder', w.publicKey.toBase58());
const f = await api('/api/chain/faucet', { wallet: w.publicKey.toBase58() });
console.log(`faucet  ${f.amount} REX + ${f.sol} SOL`);
await sleep(2500);

console.log('\n1. bid into the Fair Open');
const bid = await api('/api/chain/build/commit', { wallet: w.publicKey.toBase58(), mint: MINT, amount: 50_000 * 1e6 });
console.log('   ', (await signSend(bid.tx, w)).slice(0, 16) + '…');

console.log('\n2. wait for the bell (the crank settles permissionlessly)');
let st = '';
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  const l = (await api(`/api/chain/launch?mint=${MINT}`)).launch;
  if (l.status !== st) { st = l.status; console.log(`   ${new Date().toISOString().slice(11,19)}  ${st}`); }
  if (st === 'live' || st === 'graduated') break;
}
if (st !== 'live' && st !== 'graduated') { console.log('   ❌ never cleared'); process.exit(1); }

console.log('\n3. claim the fill');
const cl = await api('/api/chain/build/claim-fairopen', { wallet: w.publicKey.toBase58(), mint: MINT });
console.log('   ', (await signSend(cl.tx, w)).slice(0, 16) + '…');
await sleep(3000);
let me = await api(`/api/chain/me?mint=${MINT}&wallet=${w.publicKey.toBase58()}`);
console.log('    position', me.position ? me.position.amount / 1e6 : 0, 'tokens');

console.log('\n4. buy on the curve');
const buy = await api('/api/chain/build/buy', { wallet: w.publicKey.toBase58(), mint: MINT, quoteIn: 20_000 * 1e6 });
console.log('   ', (await signSend(buy.tx, w)).slice(0, 16) + '…');
await sleep(3000);
me = await api(`/api/chain/me?mint=${MINT}&wallet=${w.publicKey.toBase58()}`);
console.log('    position now', me.position ? me.position.amount / 1e6 : 0, 'tokens');

console.log('\n5. sell a slice back');
const half = Math.floor((me.position.amount) / 4);
const sell = await api('/api/chain/build/sell', { wallet: w.publicKey.toBase58(), mint: MINT, tokensIn: half });
console.log('   ', (await signSend(sell.tx, w)).slice(0, 16) + '…');
await sleep(4000);

const l = (await api(`/api/chain/launch?mint=${MINT}`)).launch;
console.log(`\nbuckets after trading — holders ${l.rewardPot / 1e6} · creator ${l.creatorPot / 1e6} · REX ${l.rexPot / 1e6} · owner ${l.partnerPot / 1e6} REX`);
const owner = l.partnerPot, bucket = l.rexPot + l.partnerPot;
console.log(`owner share of the REX bucket: ${bucket ? (owner / bucket * 100).toFixed(2) : '—'}%  (want 3.00%)`);
console.log(`\nbalance left on the bidder: ${(await conn.getBalance(w.publicKey)) / LAMPORTS_PER_SOL} SOL`);
