// Creates the stand-in quote mints a devnet deployment needs, with the crank as mint authority so
// the site's faucet can hand them out. Mainnet quote mints hold nothing on devnet, so without these
// a launch has nothing real to be priced against.
//
//   RPC_URL=https://api.devnet.solana.com CRANK_KEY=<secret> node tools/devnet-mints.mjs
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createMint, getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import fs from 'node:fs';

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
if (!/devnet|localhost|127\.0\.0\.1/.test(RPC)) { console.error('refusing to run against anything but devnet/local'); process.exit(1); }
// The authority can come from the crank secret or from a keypair FILE. The file matters: the site's
// faucet mints these, so whatever signs here has to be the same key the server signs with — and on
// this deployment that key is the deployer's own id.json, not a separate crank.
const key = process.env.CRANK_KEY;
const kpFile = process.env.KEYPAIR || (key ? null : `${process.env.HOME}/.config/solana/id.json`);
const crank = key
  ? Keypair.fromSecretKey(bs58.decode(key))
  : Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpFile, 'utf8'))));
const conn = new Connection(RPC, 'confirmed');

// Every quote asset the launch screen offers, with ITS OWN decimals.
//
// Decimals are not cosmetic here and they are not all 6: Monero is 12 on Solana, every xStock is 8,
// HYPE and TAO are 9. A stand-in minted at the wrong precision prices its pairs out by orders of
// magnitude — in the market cap, the reward pot and every payout — so the list is derived from the
// real quote table rather than retyped, and cannot drift away from it.
//
// SOL is excluded on purpose: it is native and already exists on devnet. Anything already present in
// the output file is left alone, so re-running this never replaces a mint people hold.
const { QUOTES } = await import('../lib/prices.mjs');
const WANT = Object.values(QUOTES)
  .filter((q) => q.symbol !== 'SOL')
  .map((q) => [q.symbol, q.decimals ?? 6]);
const OUT = process.env.OUT || 'devnet-mints.json';
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (e) => /429|too many requests/i.test(String(e?.message || e));
// The public devnet RPC rate-limits mint creation well before anything else, so each one is retried
// and the run is paced. Neither affects what is created, only how fast we ask for it.
async function retry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || !is429(e)) throw e; await sleep(800 * 2 ** i + Math.random() * 400); }
  }
}
// Written after EVERY mint, not at the end. A crash part-way through used to lose the record of
// mints that already existed on chain, orphaning them: the SOL is spent, the address is gone, and
// the next run creates another one.
const save = () => fs.writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');

console.log(`authority ${crank.publicKey.toBase58()}  balance ${(await conn.getBalance(crank.publicKey)) / 1e9} SOL\n`);
for (const [symbol, decimals] of WANT) {
  if (existing[symbol]) {
    const info = await retry(() => getMint(conn, new PublicKey(existing[symbol]))).catch(() => null);
    if (info) {
      const warn = info.decimals !== decimals ? `  ⚠ decimals ${info.decimals}, want ${decimals}` : '';
      console.log(`· ${symbol.padEnd(7)} already ${existing[symbol]}${warn}`);
      continue;
    }
  }
  const mint = await retry(() => createMint(conn, crank, crank.publicKey, null, decimals));
  existing[symbol] = mint.toBase58();
  save();
  console.log(`✅ ${symbol.padEnd(7)} ${mint.toBase58()}  (${decimals} dp)`);
  await sleep(Number(process.env.PACE_MS || 400));
}
save();
console.log(`\nwrote ${OUT}`);
console.log(`balance now ${(await conn.getBalance(crank.publicKey)) / 1e9} SOL`);
