// Takes a launch all the way: Fair Open → curve → graduation → a REAL Raydium CPMM pool with the
// LP burned. The point of the exercise is the last part — a pool on a program DexScreener, Birdeye
// and Jupiter already read, which is the only way a REX coin gets a chart anywhere but our own site.
//
//   BASE=http://127.0.0.1:8788 node tools/devnet_migrate.mjs
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL, PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { getAccount, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

process.env.RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const conn = new Connection(process.env.RPC_URL, 'confirmed');
const api = async (p, body) => {
  const r = await fetch(BASE + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${p} → ${r.status} ${j.error || ''}`); return j;
};
const sign = async (b64, kp) => { const t = Transaction.from(Buffer.from(b64, 'base64')); t.partialSign(kp); return (await api('/api/chain/send', { tx: t.serialize().toString('base64') })).signature; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const CH = await import('../lib/chain.mjs');
const R = await import('../lib/raydium.mjs');

// A launch small enough to graduate in one buy — graduation is the precondition for migrating.
const w = Keypair.generate();
console.log('migrator', w.publicKey.toBase58());
const f = await api('/api/chain/faucet', { wallet: w.publicKey.toBase58() });
console.log(`faucet ${f.amount} REX + ${f.sol} SOL`);
await sleep(2500);
// the pool creation fee is 0.15 SOL and Raydium charges the creator, so top the migrator up
const extra = 0.4 * LAMPORTS_PER_SOL - (await conn.getBalance(w.publicKey));
if (extra > 0) {
  const crank = Keypair.fromSecretKey(bs58.decode(process.env.CRANK_KEY));
  const { SystemProgram } = await import('@solana/web3.js');
  const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: w.publicKey, lamports: extra }));
  t.feePayer = crank.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; t.sign(crank);
  await conn.confirmTransaction({ signature: await conn.sendRawTransaction(t.serialize()), ...(await conn.getLatestBlockhash('confirmed')) }, 'confirmed');
}
console.log(`migrator balance ${(await conn.getBalance(w.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

const st = await api('/api/state');
const rex = st.quotes.find((q) => q.symbol === 'REX');
// tiny raise so one buy clears the curve
const raiseTarget = 50_000 * 1e6;
const built = await api('/api/chain/build/create', {
  wallet: w.publicKey.toBase58(), quoteMint: rex.mint, raiseTarget,
  vQuote0: Math.floor(raiseTarget * 30 / 85), holderBps: 100, creatorBps: 50, vaultBps: 50,
  burnBps: 0, buybackBps: 0, fairOpenSecs: 0,
});
await api('/api/chain/meta', { wallet: w.publicKey.toBase58(), mint: built.mint, name: 'Raydium Migration', symbol: 'RAYMIG', description: 'Graduates into a real Raydium CPMM pool with the LP burned.', image: PNG });
await sign(built.tx, w);
const mint = built.mint;
console.log(`launched ${mint}`);

console.log('\nbuying past the raise target to graduate…');
const buy = await api('/api/chain/build/buy', { wallet: w.publicKey.toBase58(), mint, quoteIn: 120_000 * 1e6 });
await sign(buy.tx, w);
await sleep(3500);
let l = (await api(`/api/chain/launch?mint=${mint}`)).launch;
const statusOf = (x) => (typeof x === 'string' ? x : Object.keys(x)[0]);
ok(statusOf(l.status).toLowerCase() === 'graduated', `graduated — AMM holds ${l.ammQuote / 1e6} REX / ${l.ammToken / 1e6} tokens`);
if (statusOf(l.status).toLowerCase() !== 'graduated') process.exit(1);

console.log('\nmigrating into Raydium, one atomic transaction…');
const m = await CH.buildMigrate({ mint, migrator: w.publicKey.toBase58() });
console.log(`  pool   ${m.pool}`);
console.log(`  lpMint ${m.lpMint}`);
const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...m.ixs);
tx.feePayer = w.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
tx.sign(w);
let sig;
try {
  sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash('confirmed')) }, 'confirmed');
  ok(true, `migrated · ${sig.slice(0, 16)}…`);
} catch (e) {
  ok(false, `migration failed: ${String(e.message).split('\n')[0]}`);
  const logs = await e.getLogs?.(conn).catch(() => null);
  if (logs) console.log(logs.slice(-14).join('\n'));
  process.exit(1);
}

await sleep(3000);
const pool = await conn.getAccountInfo(new PublicKey(m.pool));
ok(!!pool && pool.owner.equals(R.CPMM), `the pool exists and is owned by Raydium cp-swap`);
const lp = await getMint(conn, new PublicKey(m.lpMint), 'confirmed', TOKEN_PROGRAM_ID);
ok(lp.supply === 0n, `LP supply is ${lp.supply} — nobody holds a claim on the liquidity`);
const v0 = await getAccount(conn, new PublicKey((await R.migrateAccounts({ launch: CH.launchPda(mint).toBase58(), mint, quoteMint: rex.mint, tokenVault: CH.tokenVaultPda(CH.launchPda(mint)).toBase58(), quoteVault: CH.quoteVaultPda(CH.launchPda(mint)).toBase58(), payer: w.publicKey.toBase58(), tokenProgramOf: CH.tokenProgramOf })).poolVault0), 'confirmed');
ok(v0.amount > 0n, `the pool's first vault holds ${v0.amount} base units`);
// read the account itself, not the API — that one is cached and would show a stale status
const after = await CH.launchOf(mint);
ok(statusOf(after.status).toLowerCase() === 'migrated', `the launch reads "${statusOf(after.status)}"`);
ok(Number(after.ammQuote) === 0 && Number(after.ammToken) === 0, 'and holds no reserves of its own any more');
// Trading here must be refused outright now. BUILDING a buy still works — the server will happily
// assemble a transaction — so the check has to actually send it. The program is what refuses.
let refused = false;
try {
  const b = await api('/api/chain/build/buy', { wallet: w.publicKey.toBase58(), mint, quoteIn: 1_000_000 });
  await sign(b.tx, w);
} catch { refused = true; }
ok(refused, 'a buy on the old curve is refused on chain — the liquidity is on Raydium now');

console.log(`\nhttps://solscan.io/account/${m.pool}?cluster=devnet`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
