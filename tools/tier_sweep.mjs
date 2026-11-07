// Walks one live launch down all seven REX tiers and checks ON CHAIN that the owner's pot takes
// exactly 3.00% of what the REX pot took at each of them. Run after chain_e2e against the same
// validator, so the config PDA already exists with the same deterministic crank as its authority.
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';

process.env.RPC_URL = 'http://127.0.0.1:8899';
const crank = Keypair.fromSeed(createHash('sha256').update('rexpad-e2e-crank').digest());
process.env.CRANK_KEY = bs58.encode(crank.secretKey);
const C = await import('../lib/chain.mjs');
const conn = new Connection(process.env.RPC_URL, 'confirmed');
const walletSign = (b64, ...s) => { const t = Transaction.from(Buffer.from(b64, 'base64')); t.partialSign(...s); return t.serialize().toString('base64'); };
const fund = async (k) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');

const cfg = await C.configAccount();
console.log(`program        ${C.programId().toBase58()}`);
console.log(`revenue share  ${cfg.partnerBps} bps of the REX bucket → ${cfg.partner}\n`);

const dev = Keypair.generate(); await fund(dev); await fund(crank);
const quoteMint = await createMint(conn, crank, crank.publicKey, null, 6);
for (const k of [crank, dev]) {
  const acc = await getOrCreateAssociatedTokenAccount(conn, k, quoteMint, k.publicKey);
  await mintTo(conn, crank, quoteMint, acc.address, crank, 500_000_000_000);
}

// holder bucket at its 3% maximum, nothing else on, so every fee movement is REX vs holders
const built = await C.buildCreateLaunch({ creator: dev.publicKey.toBase58(), quoteMint: quoteMint.toBase58(), raiseTarget: 40_000_000_000, vQuote0: 14_000_000_000, holderBps: 300, creatorBps: 0, vaultBps: 0, burnBps: 0, buybackBps: 0, fairOpenSecs: 0 });
await C.send(walletSign(built.tx, dev));
const mint = built.mint;
console.log(`launch ${mint}  holder bucket 3.00%\n`);

let prevRex = 0n, prevPartner = 0n, bad = 0;
for (const tier of [50, 45, 40, 35, 30, 25, 20]) {
  if (tier !== 50) await C.setRexTier(mint, tier);
  const buy = await C.buildBuy({ user: dev.publicKey.toBase58(), mint, quoteIn: 2_000_000_000 });
  await C.send(walletSign(buy.tx, dev));
  const L = (await C.launches()).find((x) => x.mint === mint);
  // `rex_pot` already holds REX's share NET of the owner's, so the gross bucket is the two together.
  const kept = BigInt(L.rexPot) - prevRex, partner = BigInt(L.partnerPot) - prevPartner;
  prevRex += kept; prevPartner += partner;
  const bucket = kept + partner;
  const want = bucket * BigInt(cfg.partnerBps) / 10000n;
  const good = partner === want && bucket > 0n;
  if (!good) bad++;
  console.log(`${good ? '✅' : '❌'} tier ${(tier / 100).toFixed(2)}%   REX bucket +${String(bucket).padStart(9)}   owner +${String(partner).padStart(8)}   REX keeps ${String(kept).padStart(9)}   ${(Number(partner) / Number(bucket) * 100).toFixed(4)}% of the bucket`);
}
console.log(`\n${bad === 0 ? `✅ 7/7 tiers — the owner takes exactly ${(cfg.partnerBps / 100).toFixed(2)}% of the REX bucket, at every tier` : `❌ ${bad} tier(s) wrong`}`);
process.exit(bad === 0 ? 0 : 1);
