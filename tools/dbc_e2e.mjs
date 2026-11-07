// One REX-style launch on Meteora DBC, end to end, on devnet.
//
// This is the proof the whole move rests on. Everything else — the fee crank, the indexer, the UI —
// is downstream of the single question "does a REX-shaped launch actually work on DBC, quoted in a
// REX-shaped token, and does trading it accrue a fee we can claim".
//
//   node tools/dbc_e2e.mjs
//
// It creates its own Token-2022 quote mint shaped exactly like $REX (metadata extensions only, no
// transfer fee, no hook), launches against it, buys, and reads back the accrued fee. Nothing here
// is simulated: every step is a real devnet transaction.
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction, getMintLen, LENGTH_SIZE, TYPE_SIZE,
  getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';
import fs from 'node:fs';

process.env.RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const MET = await import('../lib/meteora.mjs');

const conn = new Connection(process.env.RPC_URL, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
process.env.FEE_CLAIMER = process.env.FEE_CLAIMER || payer.publicKey.toBase58();

const ui = (n, d = 6) => Number(n) / 10 ** d;
let step = 0;
const say = (m) => console.log(`\n${++step}. ${m}`);

console.log('Meteora DBC end-to-end — devnet');
console.log('payer  ', payer.publicKey.toBase58());
console.log('balance', ((await conn.getBalance(payer.publicKey)) / 1e9).toFixed(4), 'SOL');

// ---------------------------------------------------------------- 1. a $REX-shaped quote mint
say('Create a $REX-shaped quote mint (Token-2022, metadata extensions only)');
const quoteKp = Keypair.generate();
{
  const meta = { mint: quoteKp.publicKey, name: 'Test REX', symbol: 'TREX', uri: '', additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: quoteKp.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(quoteKp.publicKey, payer.publicKey, quoteKp.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(quoteKp.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: quoteKp.publicKey, metadata: quoteKp.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri, mintAuthority: payer.publicKey, updateAuthority: payer.publicKey }),
  );
  await sendAndConfirmTransaction(conn, tx, [payer, quoteKp], { commitment: 'confirmed' });
  console.log('   quote mint', quoteKp.publicKey.toBase58());
}

say('Fund the launcher with quote tokens to buy with');
{
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, quoteKp.publicKey, payer.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID);
  await mintTo(conn, payer, quoteKp.publicKey, ata.address, payer, 10_000_000_000n, [], { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
  console.log('   minted 10,000 TREX to', ata.address.toBase58().slice(0, 12) + '…');
}

// ---------------------------------------------------------------- 2. the launch
say('Launch a coin against it — config, pool and dev buy in one transaction');
const launch = await MET.buildLaunch({
  conn, creator: payer.publicKey.toBase58(), quoteMint: quoteKp.publicKey.toBase58(),
  name: 'E2E Rex', symbol: 'E2E', uri: '',
  poolFeeBps: 200, creatorSharePct: 50,
  initialMarketCap: 5_000, migrationMarketCap: 50_000,
  quoteDecimals: 6, devBuy: 100_000_000n,     // 100 TREX
});
console.log('   mint  ', launch.mint);
console.log('   config', launch.config);
for (const st of launch.steps) {
  const sig = await sendAndConfirmTransaction(conn, st.tx, [payer, ...st.signers], { commitment: 'confirmed' });
  console.log(`   ${st.label.padEnd(12)}`, sig.slice(0, 24) + '…');
}

// ---------------------------------------------------------------- 3. is it real?
say('Read the pool back off the chain');
const poolAddr = launch.pool;                 // derived at launch — no scan, no lag
const acc = await conn.getAccountInfo(new PublicKey(poolAddr));
if (!acc) { console.error('   ❌ no pool account at', poolAddr); process.exit(1); }
console.log('   pool  ', poolAddr, `(${acc.data.length} bytes on chain)`);
console.log('   ✅ the launch exists on Meteora');

// ---------------------------------------------------------------- 4. trade it
say('Buy, so that a fee actually accrues');
{
  const q = await MET.quoteSwap({ conn, pool: poolAddr, amountIn: 50_000_000n, swapBaseForQuote: false }).catch((e) => { console.log('   quote failed:', e.message.slice(0, 90)); return null; });
  if (q) console.log(`   quote: 50 TREX -> ${ui(q.out)} E2E (fee ${ui(q.fee)})`);
  const tx = await MET.buildSwap({ conn, owner: payer.publicKey.toBase58(), pool: poolAddr, amountIn: 50_000_000n, minimumAmountOut: 1n, swapBaseForQuote: false });
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  console.log('   bought', sig.slice(0, 24) + '…');
}

// ---------------------------------------------------------------- 5. did we earn?
say('Read the accrued fee — this is the number that did not exist under the old design');
const fees = await MET.feesOf(conn, poolAddr);
console.log('   partner side:', ui(fees.partnerQuote), 'TREX');
console.log('   creator side:', ui(fees.creatorQuote), 'TREX');
const earned = fees.partnerQuote > 0n || fees.creatorQuote > 0n;
console.log(earned ? '   ✅ fees accrued and are claimable' : '   ⚠ nothing accrued yet');

// ---------------------------------------------------------------- 6. claim it
say('Claim REX Chain\'s side — the step that does not exist under the old design at all');
if (fees.partnerQuote > 0n) {
  const before = await conn.getTokenAccountBalance(
    (await getOrCreateAssociatedTokenAccount(conn, payer, quoteKp.publicKey, payer.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
  ).then((r) => BigInt(r.value.amount)).catch(() => 0n);

  const tx = await MET.buildClaimPartnerFee({
    conn, feeClaimer: payer.publicKey.toBase58(), pool: poolAddr,
    maxBase: fees.partnerBase, maxQuote: fees.partnerQuote,
  });
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
  console.log('   claimed', sig.slice(0, 24) + '…');

  const after = await conn.getTokenAccountBalance(
    (await getOrCreateAssociatedTokenAccount(conn, payer, quoteKp.publicKey, payer.publicKey, false, 'confirmed', undefined, TOKEN_2022_PROGRAM_ID)).address
  ).then((r) => BigInt(r.value.amount)).catch(() => 0n);

  const delta = after - before;
  console.log(`   wallet ${ui(before)} -> ${ui(after)} TREX  (+${ui(delta)})`);
  console.log(delta > 0n ? '   ✅ the money actually arrived' : '   ❌ claim confirmed but nothing moved');

  const left = await MET.feesOf(conn, poolAddr);
  console.log(`   unclaimed partner fee now: ${ui(left.partnerQuote)} TREX`);

  // The split that replaces on-chain enforcement.
  const FEES = await import('../lib/fees.mjs');
  const buckets = FEES.bucketsOf({ holder_bps: 5000, vault_bps: 2000, burn_bps: 1000, buyback_bps: 500 });
  const { parts, remainder } = FEES.splitClaim(delta, buckets);
  console.log('   would split:', Object.entries(parts).map(([k, v]) => `${k} ${ui(v)}`).join(' · '),
    remainder > 0n ? `(dust ${ui(remainder)} carried)` : '');
  const sum = Object.values(parts).reduce((a, b) => a + b, 0n) + remainder;
  console.log(sum === delta ? '   ✅ split accounts for every base unit claimed' : '   ❌ SPLIT LOSES MONEY');
} else {
  console.log('   nothing accrued to claim');
}

console.log('\n' + '─'.repeat(64));
console.log(earned ? '✅ END TO END PASSED' : '⚠ launch and trade worked; fee read returned zero');
console.log('   mint ', launch.mint);
console.log('   pool ', poolAddr);
console.log('   Under the old design this coin would have been invisible to every');
console.log('   aggregator until graduation, and would have earned REX nothing after it.');
