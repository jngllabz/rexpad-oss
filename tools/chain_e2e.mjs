// Proves the SERVER-BUILD → WALLET-SIGN → BROADCAST path end to end against a live validator.
// Every user action goes through lib/chain.mjs exactly as the browser will drive it; the only
// difference is that a local Keypair signs instead of Phantom.
// Run: RPC_URL=http://127.0.0.1:8899 node tools/chain_e2e.mjs
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';

process.env.RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
// Deterministic crank so re-runs against the same validator reuse the config PDA's authority.
const crank = process.env.CRANK_IS_FUNDER === '1' && process.env.FUNDER
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse((await import('node:fs')).readFileSync(process.env.FUNDER, 'utf8'))))
  : Keypair.fromSeed(createHash('sha256').update('rexpad-e2e-crank').digest());
process.env.CRANK_KEY = bs58.encode(crank.secretKey);

const C = await import('../lib/chain.mjs');


const conn = new Connection(process.env.RPC_URL, 'confirmed');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, tol = 1e-6) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(b)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// On a public cluster the faucet is usually rate-limited, so fall back to transferring from a
// funded wallet (FUNDER=<path to keypair json>).
import fsx from 'node:fs';
import { SystemProgram as SP } from '@solana/web3.js';
const funder = process.env.FUNDER ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fsx.readFileSync(process.env.FUNDER, 'utf8')))) : null;
const FUND_SOL = Number(process.env.FUND_SOL || 20);
const FO_SECS = Number(process.env.FAIR_OPEN_SECS || 4); // widen on a public cluster: RPC throttling eats seconds
const fund = async (kp, sol = FUND_SOL) => {
  if (!funder) { const s = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL); const bh = await conn.getLatestBlockhash(); await conn.confirmTransaction({ signature: s, ...bh }, 'confirmed'); return; }
  const tx = new Transaction().add(SP.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  tx.feePayer = funder.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; tx.sign(funder);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  const bh = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
};

/** What Phantom does: take the server's base64, sign it, hand it back. */
function walletSign(b64, ...signers) {
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  tx.partialSign(...signers);
  return tx.serialize().toString('base64');
}

(async () => {
  console.log('RPC', process.env.RPC_URL, '\nprogram', C.programId().toBase58(), '\n');
  const dev = Keypair.generate(), a = Keypair.generate(), b = Keypair.generate();
  for (const k of [crank, dev, a, b]) await fund(k);

  // stand-in $REX
  const quoteMint = await createMint(conn, crank, crank.publicKey, null, 6);
  const qAta = {};
  for (const k of [crank, dev, a, b]) {
    const acc = await getOrCreateAssociatedTokenAccount(conn, k, quoteMint, k.publicKey);
    qAta[k.publicKey.toBase58()] = acc.address;
    await mintTo(conn, crank, quoteMint, acc.address, crank, 500_000_000_000);
  }

  let reused = false;
  try { await C.initConfig({ feeWallet: crank.publicKey }); } catch { reused = true; }
  const cfgAcc = await C.configAccount();
  ok(cfgAcc && cfgAcc.curveFeeBps === 100, `config ready through the chain layer${reused ? ' [reused]' : ''}`);
  if (cfgAcc.authority !== crank.publicKey.toBase58()) { console.log('\n⚠ config owned by another authority — restart the validator with -r'); process.exit(2); }

  // ---------- create a launch: server builds, creator signs
  const built = await C.buildCreateLaunch({ creator: dev.publicKey.toBase58(), quoteMint: quoteMint.toBase58(), raiseTarget: 40_000_000_000, vQuote0: 14_000_000_000, holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0, buybackBps: 0, fairOpenSecs: FO_SECS });
  const sim = await C.simulate(walletSign(built.tx, dev));
  ok(!sim.err, `server-built launch tx simulates clean (${sim.units} CU)`);
  await C.send(walletSign(built.tx, dev));
  let L = (await C.launches()).find((x) => x.mint === built.mint);
  ok(L && L.status === 'fairopen' && L.realToken === 793_100_000_000_000, 'launch live on chain, 793.1M on the curve');
  const supply = await conn.getTokenSupply(new PublicKey(built.mint));
  ok(supply.value.amount === '1000000000000000', 'mint carries the full 1B supply');

  // ---------- Fair Open: three sealed commitments, server-built
  const commits = { [dev.publicKey.toBase58()]: 2_000_000_000, [a.publicKey.toBase58()]: 1_000_000_000, [b.publicKey.toBase58()]: 4_000_000_000 };
  for (const who of [dev, a, b]) {
    const { tx } = await C.buildCommit({ bidder: who.publicKey.toBase58(), mint: built.mint, amount: commits[who.publicKey.toBase58()] });
    await C.send(walletSign(tx, who));
  }
  L = (await C.launches()).find((x) => x.mint === built.mint);
  ok(L.fairOpenTotal === 7_000_000_000, 'all three commitments escrowed on chain (7,000)');
  const mine = await C.commitOf(built.mint, a.publicKey.toBase58());
  ok(mine.amount === 1_000_000_000, 'per-wallet commitment readable for the UI');

  // ---------- the bell, rung by the crank
  // wait for the window against CLUSTER time, then ring the bell
  for (let i = 0; i < 60; i++) { if ((await C.clusterTime()) > (await C.launchOf(built.mint)).fairOpenEnds) break; await sleep(2000); }
  let settled = [];
  for (let i = 0; i < 10 && !settled.length; i++) { settled = await C.settleDue(); if (!settled.length) await sleep(2000); }
  ok(settled.length >= 1, 'crank rang the bell on the expired window');
  L = (await C.launches()).find((x) => x.mint === built.mint);
  ok(L.status === 'live' && L.fairOpenTokens > 0, 'launch moved to live with tokens allocated');

  // ---------- claims prove the uniform price
  const prices = {};
  for (const who of [dev, a, b]) {
    const { tx } = await C.buildClaimFairOpen({ bidder: who.publicKey.toBase58(), mint: built.mint });
    await C.send(walletSign(tx, who));
    const bal = Number((await getAccount(conn, (await getOrCreateAssociatedTokenAccount(conn, who, new PublicKey(built.mint), who.publicKey)).address)).amount);
    prices[who.publicKey.toBase58()] = commits[who.publicKey.toBase58()] / bal;
  }
  const pv = Object.values(prices);
  ok(pv.every((p) => near(p, pv[0])), `all three cleared at ONE price (${pv[0].toExponential(6)})`);
  ok(near(prices[dev.publicKey.toBase58()], prices[a.publicKey.toBase58()]), 'the dev paid the same as everyone — no first bite');

  // ---------- trading + the conviction clock
  let pos = await C.positionOf(built.mint, a.publicKey.toBase58());
  const held0 = pos.heldSince;
  ok(held0 > 0, 'conviction clock running on chain after the claim');

  const buy = await C.buildBuy({ user: a.publicKey.toBase58(), mint: built.mint, quoteIn: 500_000_000 });
  await C.send(walletSign(buy.tx, a));
  pos = await C.positionOf(built.mint, a.publicKey.toBase58());
  ok(pos.heldSince === held0, 'buying more keeps the clock');

  const sell = await C.buildSell({ user: a.publicKey.toBase58(), mint: built.mint, tokensIn: 1_000_000 });
  await C.send(walletSign(sell.tx, a));
  pos = await C.positionOf(built.mint, a.publicKey.toBase58());
  ok(pos.heldSince === 0, 'selling resets the clock to zero, on chain');

  // ---------- the four buckets, read straight off the chain
  L = (await C.launches()).find((x) => x.mint === built.mint);
  ok(L.holderBps === 200 && L.creatorBps === 100 && L.vaultBps === 100 && L.burnBps === 0 && L.totalFeeBps === 400,
    `the launch carries a 2 / 1 / 1 split (${L.totalFeeBps / 100}% total)`);
  // REX's cut is rexPot + partnerPot: if a revenue share is configured, part of it is already
  // segregated to the partner. Together they are the protocol fee carved out of the holder allocation.
  const ours = L.rexPot + (L.partnerPot || 0);
  ok(L.rewardPot > 0 && ours > 0 && near(ours / (L.rewardPot + ours), L.rexBps / L.holderBps, 1e-6),
    `REX took its ${(L.rexBps / 100).toFixed(2)}% OUT of the ${(L.holderBps / 100).toFixed(1)}% holder allocation, not on top (${ours}${L.partnerPot ? `, of which ${L.partnerPot} is the revenue share` : ''})`);
  ok(L.creatorPot > 0 && L.vaultPot > 0 && L.burnPot === 0, `creator and vault filled, burn stayed at zero (${L.creatorPot} / ${L.vaultPot})`);
  ok(L.volumeQuote > 0, `verified-volume counter is running (${L.volumeQuote})`);

  // ---------- reward epoch: PRO-RATA TO BALANCE, $20 floor, merkle root, real claims
  const positions = await C.positionsOf(built.mint);
  ok(positions.length >= 2, `${positions.length} positions read back for the snapshot`);
  const { weighted, total, floorTokens } = C.proRata(positions, { priceUsd: 0, floorUsd: 20 });
  ok(weighted.every((w) => near(w.share, w.amount / total)), 'every share is exactly its slice of the balance — hold time weighs nothing');
  const floored = C.proRata([{ owner: 'dust', amount: 1 }, ...positions], { priceUsd: 1e-6, floorUsd: 20 });
  ok(floored.skipped.some((x) => x.owner === 'dust') && !floored.weighted.some((x) => x.owner === 'dust'),
    'a position under the $20 floor is skipped, and its share stays in the pool');
  const excluded = C.proRata(positions, { exclude: new Set([positions[0].owner]) });
  ok(!excluded.weighted.some((x) => x.owner === positions[0].owner), 'an excluded wallet (pool / vault / burner / team lock) earns nothing');

  const pot = Math.floor(L.rewardPot * 0.9);
  const alloc = C.allocate(weighted, total, pot);
  const ep = C.epochPda(C.launchPda(built.mint), L.epochCount).toBase58();
  const leaves = alloc.map((x) => C.leafOf(x.owner, x.amount, ep));
  const { root, layers } = C.buildTree(leaves);
  await C.postEpoch(built.mint, root, pot);
  const epochs = await C.epochsOf(built.mint);
  ok(epochs.length === 1 && epochs[0].pot === pot, `epoch posted on chain (pot ${pot})`);

  const idx = alloc.findIndex((x) => x.owner === b.publicKey.toBase58());
  const before = Number((await getAccount(conn, qAta[b.publicKey.toBase58()])).amount);
  const claim = await C.buildClaimReward({ claimant: b.publicKey.toBase58(), mint: built.mint, index: 0, amount: alloc[idx].amount, proof: C.proofFor(layers, idx) });
  await C.send(walletSign(claim.tx, b));
  const after = Number((await getAccount(conn, qAta[b.publicKey.toBase58()])).amount);
  ok(after - before === alloc[idx].amount, `merkle claim paid exactly the pro-rata share (${after - before})`);

  let threw = false;
  try { await C.send(walletSign((await C.buildClaimReward({ claimant: b.publicKey.toBase58(), mint: built.mint, index: 0, amount: alloc[idx].amount, proof: C.proofFor(layers, idx) })).tx, b)); } catch { threw = true; }
  ok(threw, 'the same wallet cannot claim an epoch twice');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e.message || e); if (e.logs) console.error(e.logs.slice(-12).join('\n')); process.exit(1); });
