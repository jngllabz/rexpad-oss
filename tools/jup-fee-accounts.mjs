// Opens the token accounts REX's Jupiter fee lands in.
//
// Jupiter takes a platform fee into a token account for one of the route's mints and will NOT create
// that account for you — name one that does not exist and the swap fails on chain. lib/jupiter.mjs
// therefore quotes fee-free for any mint whose account is missing, so a gap here costs revenue and
// never costs a user their swap. This opens them.
//
// It spends real mainnet SOL: about 0.002 per account, once, refundable if ever closed.
//
// The payer and the owner do NOT have to be the same wallet — an associated token account can be
// opened by anyone on anyone's behalf. That matters here: the income wallet REX nominated holds no
// SOL, so somebody else funds the accounts and REX still owns every one of them.
//
//   JUP_FEE_WALLET=<owner pubkey> FEE_KEY=<any funded mainnet payer's base58 secret> \
//     node tools/jup-fee-accounts.mjs [--all]
//
// Without --all it opens accounts for the handful of mints most routes end in. With --all it walks
// the verified list, which is hundreds of accounts and hundreds of transactions — do not start there.
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

const RPC = process.env.JUP_RPC || 'https://api.mainnet-beta.solana.com';
const owner = process.env.JUP_FEE_WALLET;
const secret = process.env.FEE_KEY;
if (!owner) { console.error('set JUP_FEE_WALLET to the wallet the fee should land in'); process.exit(1); }
if (!secret) { console.error('set FEE_KEY to that wallet\'s base58 secret key (it pays the rent)'); process.exit(1); }
const payer = Keypair.fromSecretKey(bs58.decode(secret));
const ownerPk = (() => { try { return new PublicKey(owner); } catch { console.error(`"${owner}" is not a valid address`); process.exit(1); } })();
const conn = new Connection(RPC, 'confirmed');

// What a swap most often ends in. The fee is taken on the OUTPUT side, so these are the ones worth
// having open on day one.
const CORE = [
  ['SOL',  'So11111111111111111111111111111111111111112'],
  ['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
  ['REX',  process.env.REX_CA || 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump'],
  ['JUP',  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['BONK', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'],
];

let mints = CORE;
if (process.argv.includes('--all')) {
  const r = await fetch('https://lite-api.jup.ag/tokens/v2/tag?query=verified');
  const j = await r.json();
  mints = (Array.isArray(j) ? j : j.tokens || []).map((t) => [t.symbol, t.id || t.address]).filter(([, m]) => m);
  console.log(`walking the whole verified list — ${mints.length} mints\n`);
}

console.log(`fee wallet (owner) ${owner}`);
console.log(`rent payer         ${payer.publicKey.toBase58()}${payer.publicKey.toBase58() === owner ? '  (same wallet)' : '  (different wallet — it only pays, it never owns)'}`);
console.log(`payer balance      ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL\n`);

// Not every mint lives under the same token program. $REX is Token-2022, USDC and the rest are
// legacy SPL — and the associated-token address DERIVES from the program, so assuming one of them
// produces the wrong account and the instruction fails with IncorrectProgramId. Ask the chain.
async function programOf(mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint), 'confirmed');
  if (!info) return null;
  const o = info.owner.toBase58();
  if (o === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (o === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return null;
}

let made = 0, had = 0, failed = 0;
for (let i = 0; i < mints.length; i += 8) {
  const batch = mints.slice(i, i + 8);
  const ixs = [];
  for (const [sym, mint] of batch) {
    let prog, ata;
    try {
      prog = await programOf(mint);
      if (!prog) { console.log(`· ${sym.padEnd(6)} not a token mint on this cluster, skipped`); failed++; continue; }
      ata = getAssociatedTokenAddressSync(new PublicKey(mint), ownerPk, true, prog);
    } catch { console.log(`· ${sym.padEnd(6)} bad mint, skipped`); failed++; continue; }
    if (await conn.getAccountInfo(ata, 'confirmed')) { console.log(`· ${sym.padEnd(6)} already open`); had++; continue; }
    // payer pays the rent, ownerPk owns the account and everything that ever lands in it
    ixs.push({ sym, prog: prog.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? 'token-2022' : 'spl-token',
      ix: createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, ownerPk, new PublicKey(mint), prog) });
  }
  // One transaction per account rather than one for the batch: these are independent, and batching
  // them meant a single unopenable mint rolled back five good ones.
  for (const x of ixs) {
    try {
      const tx = new Transaction().add(x.ix);
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash('confirmed')) }, 'confirmed');
      console.log(`✅ ${x.sym.padEnd(6)} opened  (${x.prog})`);
      made++;
    } catch (e) { console.log(`❌ ${x.sym.padEnd(6)} ${String(e.message).split('\n')[0].slice(0, 90)}`); failed++; }
  }
}
console.log(`\n${made} opened · ${had} already there · ${failed} failed`);
console.log(`balance now ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
console.log(`\nSet JUP_FEE_WALLET=${owner} on the server and the 0.5% starts being taken on routes ending in these mints.`);
