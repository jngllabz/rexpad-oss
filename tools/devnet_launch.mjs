// A devnet smoke test. Exactly what the browser does on /create in chain mode: ask the faucet for funds, POST
// build/create, POST meta, sign with the wallet, POST send. If this works, Elio's click works.
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const api = async (p, body) => {
  const r = await fetch(BASE + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${p} → ${r.status} ${j.error || ''}`); return j;
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const w = Keypair.generate();
console.log('wallet', w.publicKey.toBase58());

console.log('\n1. faucet');
const f = await api('/api/chain/faucet', { wallet: w.publicKey.toBase58() });
console.log(`   ${f.amount} REX + ${f.sol} SOL  ${f.signature.slice(0, 12)}…`);
await new Promise(r => setTimeout(r, 2500));
const bal0 = await conn.getBalance(w.publicKey);
console.log(`   balance ${bal0 / LAMPORTS_PER_SOL} SOL`);

console.log('\n2. build/create');
const st = await api('/api/state');
const rex = st.quotes.find(q => q.symbol === 'REX');
const raiseTarget = Math.floor((85.0054 * 210 / (rex.usd || 1)) * 1e6);
const built = await api('/api/chain/build/create', {
  wallet: w.publicKey.toBase58(), quoteMint: rex.mint, raiseTarget,
  vQuote0: Math.floor(raiseTarget * 30 / 85.0054),
  holderBps: 300, creatorBps: 100, vaultBps: 0, burnBps: 0, buybackBps: 0, fairOpenSecs: 60,
});
console.log('   mint', built.mint);

console.log('\n3. meta');
await api('/api/chain/meta', { wallet: w.publicKey.toBase58(), mint: built.mint, name: 'Devnet Test', symbol: 'DEVTEST', description: 'first on-chain launch', image: PNG });

console.log('\n4. sign + send');
const tx = Transaction.from(Buffer.from(built.tx, 'base64'));
tx.partialSign(w);
const { signature } = await api('/api/chain/send', { tx: tx.serialize().toString('base64') });
console.log('   ', signature);

const bal1 = await conn.getBalance(w.publicKey);
console.log(`\n   launch cost ${((bal0 - bal1) / LAMPORTS_PER_SOL).toFixed(5)} SOL`);

console.log('\n5. does it come back through the API?');
await new Promise(r => setTimeout(r, 6000));
const one = await api(`/api/chain/launch?mint=${built.mint}`);
console.log('   on chain:', one.launch.status, '· holder', one.launch.holderBps, 'bps · rex', one.launch.rexBps, 'bps');
const list = await api('/api/tokens?limit=5');
const seen = list.tokens.find(t => t.mint === built.mint);
console.log('   in the token list:', seen ? `$${seen.symbol} "${seen.name}" · ${seen.status} · quote ${seen.quote}` : '— NOT INDEXED YET');
console.log('\nexplorer https://solscan.io/tx/' + signature + '?cluster=devnet');
