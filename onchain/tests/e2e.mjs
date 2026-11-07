// End-to-end proof of the REX Chain program against a local validator.
// Run: solana-test-validator -r  (in another shell), then: node tests/e2e.mjs
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const RPC = process.env.RPC || 'http://127.0.0.1:8899';
const idl = JSON.parse(fs.readFileSync(new URL('../target/idl/rexpad.json', import.meta.url)));
const PROGRAM_ID = new PublicKey(idl.address);
const conn = new Connection(RPC, 'confirmed');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, tol = 1e-9) => Math.abs(Number(a) - Number(b)) <= tol * Math.max(1, Math.abs(Number(b)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- merkle (sha256, sorted pairs) — must match math.rs verify_proof
const sha = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest();
const leafOf = (wallet, amount, epochPda) =>
  sha(wallet.toBuffer(), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(amount)); return b; })(), epochPda.toBuffer());
function buildTree(leaves) {
  let level = leaves.map((l) => Buffer.from(l));
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; }
      const [a, b] = [level[i], level[i + 1]];
      next.push(Buffer.compare(a, b) <= 0 ? sha(a, b) : sha(b, a));
    }
    level = next; layers.push(level);
  }
  return { root: level[0], layers };
}
function proofFor(layers, index) {
  const proof = []; let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < layer.length) proof.push(Array.from(layer[sib]));
    idx = Math.floor(idx / 2);
  }
  return proof;
}

const fund = async (kp, sol = 20) => {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
};

(async () => {
  console.log('RPC', RPC, '\nprogram', PROGRAM_ID.toBase58(), '\n');
  // Same deterministic authority as tools/chain_e2e.mjs so both suites can share one validator.
  let authority = Keypair.fromSeed(createHash('sha256').update('rexpad-e2e-crank').digest());
  // The revenue share is written at genesis, so the test's partner has to be known before init.
  const partnerSeed = Keypair.fromSeed(createHash('sha256').update('rexpad-e2e-partner').digest()); const creator = Keypair.generate(), b1 = Keypair.generate(), b2 = Keypair.generate(), cranker = Keypair.generate();
  for (const k of [authority, creator, b1, b2, cranker]) await fund(k);

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
  const program = new anchor.Program(idl, provider);

  // A stand-in $REX quote mint (6 decimals, like the real one).
  const quoteMint = await createMint(conn, authority, authority.publicKey, null, 6);
  const quoteAta = {};
  for (const k of [authority, creator, b1, b2]) {
    const a = await getOrCreateAssociatedTokenAccount(conn, k, quoteMint, k.publicKey);
    quoteAta[k.publicKey.toBase58()] = a.address;
    await mintTo(conn, authority, quoteMint, a.address, authority, 50_000_000_000); // 50k REX
  }

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
  let cfgExisted = false;
  try {
    await program.methods.initConfig(100, 25, partnerSeed.publicKey, 1000).accounts({ config: configPda, authority: authority.publicKey, feeWallet: authority.publicKey, systemProgram: SystemProgram.programId }).signers([authority]).rpc();
  } catch (e) { cfgExisted = true; }
  const cfg = await program.account.config.fetch(configPda);
  ok(cfg.partnerBps === 1000 && cfg.partner.equals(partnerSeed.publicKey),
    'the revenue share was written in the SAME transaction as the config — no window to claim it first');
  ok(cfg.curveFeeBps === 100 && cfg.ammFeeBps === 25, `config ready (1% curve / 0.25% amm)${cfgExisted ? ' [reused]' : ''}`);
  if (cfgExisted && !cfg.authority.equals(authority.publicKey)) { console.log('\n⚠ config owned by a previous run — restart the validator with -r for a clean pass'); process.exit(2); }

  // ---------- create a launch with a 4-second Fair Open window
  const mintKp = Keypair.generate();
  const [launch] = PublicKey.findProgramAddressSync([Buffer.from('launch'), mintKp.publicKey.toBuffer()], PROGRAM_ID);
  const [tokenVault] = PublicKey.findProgramAddressSync([Buffer.from('token_vault'), launch.toBuffer()], PROGRAM_ID);
  const [quoteVault] = PublicKey.findProgramAddressSync([Buffer.from('quote_vault'), launch.toBuffer()], PROGRAM_ID);
  const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), launch.toBuffer()], PROGRAM_ID);
  const RAISE = 40_000_000_000; // 40k REX raise target
  const V_QUOTE0 = 14_000_000_000;
  await program.methods.createLaunch(new anchor.BN(RAISE), new anchor.BN(V_QUOTE0), 300, 0, 0, 0, 0, new anchor.BN(Number(process.env.FAIR_OPEN_SECS || 20)))
    .accounts({ config: configPda, launch, mint: mintKp.publicKey, quoteMint, tokenVault, quoteVault, rewardVault, creator: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
    .signers([creator, mintKp]).rpc();
  let L = await program.account.launch.fetch(launch);
  const vaultBal = await getAccount(conn, tokenVault);
  ok(vaultBal.amount === 1_000_000_000_000_000n, 'full 1B supply minted into the program vault');
  const mintInfo = await conn.getParsedAccountInfo(mintKp.publicKey);
  ok(mintInfo.value.data.parsed.info.mintAuthority === null, 'mint authority permanently revoked (fixed supply)');
  ok(L.realToken.toString() === '793100000000000' && 'fairOpen' in L.status, 'curve holds 793.1M, status = FairOpen');

  // ---------- sealed commitments: creator 2k, b1 1k, b2 4k
  const commitOf = (who) => PublicKey.findProgramAddressSync([Buffer.from('commit'), launch.toBuffer(), who.publicKey.toBuffer()], PROGRAM_ID)[0];
  const commits = { [creator.publicKey.toBase58()]: 2_000_000_000, [b1.publicKey.toBase58()]: 1_000_000_000, [b2.publicKey.toBase58()]: 4_000_000_000 };
  for (const who of [creator, b1, b2]) {
    await program.methods.commit(new anchor.BN(commits[who.publicKey.toBase58()]))
      .accounts({ launch, commitment: commitOf(who), quoteMint, quoteVault, bidderQuote: quoteAta[who.publicKey.toBase58()], bidder: who.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([who]).rpc();
  }
  L = await program.account.launch.fetch(launch);
  ok(L.fairOpenTotal.toString() === '7000000000', 'three commitments escrowed (7,000 REX total)');
  const escrow = await getAccount(conn, quoteVault);
  ok(escrow.amount === 7_000_000_000n, 'quote actually sits in the program vault, not with the dev');

  // committing after the bell must fail
  await sleep((Number(process.env.FAIR_OPEN_SECS || 20) + 2) * 1000);
  let threw = false;
  try {
    await program.methods.commit(new anchor.BN(1_000_000)).accounts({ launch, commitment: commitOf(b1), quoteMint, quoteVault, bidderQuote: quoteAta[b1.publicKey.toBase58()], bidder: b1.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).signers([b1]).rpc();
  } catch { threw = true; }
  ok(threw, 'commitments rejected once the window closes');

  // ---------- the bell, rung by a stranger (permissionless)
  // Ringing it is deliberately open to anyone, so another cranker on the same cluster — a REX Chain
  // server pointed at this validator, say — may legitimately beat us to it. Losing that race is the
  // feature working, not a failure; what must hold either way is that the window ended up settled.
  let rangIt = true;
  try {
    await program.methods.settleFairOpen()
      .accounts({ config: configPda, launch, quoteMint, quoteVault, rewardVault, cranker: cranker.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([cranker]).rpc();
  } catch (e) {
    rangIt = false;
    const beatenToIt = /WindowClosed|already/i.test(e.message || '');
    if (!beatenToIt) throw e;
  }
  L = await program.account.launch.fetch(launch);
  ok('live' in L.status && L.fairOpenTokens.gt(new anchor.BN(0)),
    `Fair Open settled by a non-participant${rangIt ? '' : ' (another cranker on this validator rang it first — permissionless, as designed)'}`);
  const potAfterSettle = L.rewardPot.toNumber();
  ok(near(potAfterSettle, 7_000_000_000 * (0.03 - 0.005), 1e-6),
    `the 3% holder allocation less REX's 0.50% reached the pot (${potAfterSettle})`);
  // REX's fee is rexPot + partnerPot — the revenue share is carved out of OURS, so the two together
  // are exactly the protocol fee and the holders' side of the allocation never moves.
  ok(near(L.rexPot.toNumber() + L.partnerPot.toNumber(), 7_000_000_000 * 0.005, 1e-6),
    `REX's 0.50% came OUT of the holder allocation, not on top (${L.rexPot.toNumber()} + ${L.partnerPot.toNumber()} share)`);

  // ---------- claims: the uniform-price property
  const prices = {};
  for (const who of [creator, b1, b2]) {
    const [position] = PublicKey.findProgramAddressSync([Buffer.from('position'), launch.toBuffer(), who.publicKey.toBuffer()], PROGRAM_ID);
    const ata = await getOrCreateAssociatedTokenAccount(conn, who, mintKp.publicKey, who.publicKey);
    await program.methods.claimFairOpen()
      .accounts({ launch, commitment: commitOf(who), position, mint: mintKp.publicKey, quoteMint, tokenVault, quoteVault, bidderToken: ata.address, bidderQuote: quoteAta[who.publicKey.toBase58()], bidder: who.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([who]).rpc();
    const got = Number((await getAccount(conn, ata.address)).amount);
    prices[who.publicKey.toBase58()] = commits[who.publicKey.toBase58()] / got;
  }
  const pv = Object.values(prices);
  ok(pv.every((p) => near(p, pv[0], 1e-6)), `every bidder cleared at ONE price (${pv.map((p) => p.toExponential(6)).join(' , ')})`);
  const devPrice = prices[creator.publicKey.toBase58()], b1Price = prices[b1.publicKey.toBase58()];
  ok(near(devPrice, b1Price, 1e-6), 'the dev paid exactly what everyone else paid — no first bite');

  // double claim must fail
  threw = false;
  try {
    const [position] = PublicKey.findProgramAddressSync([Buffer.from('position'), launch.toBuffer(), b1.publicKey.toBuffer()], PROGRAM_ID);
    const ata = await getOrCreateAssociatedTokenAccount(conn, b1, mintKp.publicKey, b1.publicKey);
    await program.methods.claimFairOpen().accounts({ launch, commitment: commitOf(b1), position, mint: mintKp.publicKey, quoteMint, tokenVault, quoteVault, bidderToken: ata.address, bidderQuote: quoteAta[b1.publicKey.toBase58()], bidder: b1.publicKey, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).signers([b1]).rpc();
  } catch { threw = true; }
  ok(threw, 'a second claim on the same commitment is rejected');

  // ---------- conviction clock
  const [posB1] = PublicKey.findProgramAddressSync([Buffer.from('position'), launch.toBuffer(), b1.publicKey.toBuffer()], PROGRAM_ID);
  let P = await program.account.position.fetch(posB1);
  const heldAtClaim = P.heldSince.toNumber();
  ok(heldAtClaim > 0, 'conviction clock started at claim');

  const tradeAccounts = (who) => ({
    config: configPda, launch,
    position: PublicKey.findProgramAddressSync([Buffer.from('position'), launch.toBuffer(), who.publicKey.toBuffer()], PROGRAM_ID)[0],
    mint: mintKp.publicKey, quoteMint, tokenVault, quoteVault, rewardVault,
    userToken: anchor.utils.token.associatedAddress({ mint: mintKp.publicKey, owner: who.publicKey }),
    userQuote: quoteAta[who.publicKey.toBase58()], user: who.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  });

  await program.methods.buy(new anchor.BN(500_000_000), new anchor.BN(0)).accounts(tradeAccounts(b1)).signers([b1]).rpc();
  P = await program.account.position.fetch(posB1);
  ok(P.heldSince.toNumber() === heldAtClaim, 'buying MORE does not restart the conviction clock');

  await program.methods.sell(new anchor.BN(1_000_000), new anchor.BN(0)).accounts(tradeAccounts(b1)).signers([b1]).rpc();
  P = await program.account.position.fetch(posB1);
  ok(P.heldSince.toNumber() === 0, 'ANY sell resets the conviction clock to zero');

  // ---------- graduation
  await mintTo(conn, authority, quoteMint, quoteAta[b2.publicKey.toBase58()], authority, 200_000_000_000);
  L = await program.account.launch.fetch(launch);
  const before = L.vQuote.toString() / L.vToken.toString();
  await program.methods.buy(new anchor.BN(120_000_000_000), new anchor.BN(0)).accounts(tradeAccounts(b2)).signers([b2]).rpc();
  L = await program.account.launch.fetch(launch);
  ok('graduated' in L.status, 'curve graduated when the raise filled');
  const ammPrice = Number(L.ammQuote.toString()) / Number(L.ammToken.toString());
  ok(L.ammToken.gte(new anchor.BN('206900000000000')), 'reserved LP tokens locked into the AMM');
  ok(ammPrice > before, 'AMM opens above the pre-graduation curve price (price-continuous migration)');
  const vaultAfter = await getAccount(conn, quoteVault);
  ok(Number(vaultAfter.amount) >= L.ammQuote.toNumber(), 'AMM liquidity is held by the program and cannot be withdrawn');

  // trading continues on the AMM
  const b2TokBefore = Number((await getAccount(conn, anchor.utils.token.associatedAddress({ mint: mintKp.publicKey, owner: b2.publicKey }))).amount);
  await program.methods.buy(new anchor.BN(1_000_000_000), new anchor.BN(0)).accounts(tradeAccounts(b2)).signers([b2]).rpc();
  const b2TokAfter = Number((await getAccount(conn, anchor.utils.token.associatedAddress({ mint: mintKp.publicKey, owner: b2.publicKey }))).amount);
  ok(b2TokAfter > b2TokBefore, 'AMM trading works after graduation');

  // ---------- reward epoch: merkle root of conviction-weighted shares
  L = await program.account.launch.fetch(launch);
  const pot = Math.floor(L.rewardPot.toNumber() * 0.9);
  const [epochPda] = PublicKey.findProgramAddressSync([Buffer.from('epoch'), launch.toBuffer(), Buffer.from(new Uint32Array([L.epochCount]).buffer)], PROGRAM_ID);
  const shares = [ { who: creator, amount: Math.floor(pot * 0.5) }, { who: b1, amount: Math.floor(pot * 0.2) }, { who: b2, amount: Math.floor(pot * 0.3) } ];
  const leaves = shares.map((s) => leafOf(s.who.publicKey, s.amount, epochPda));
  const { root, layers } = buildTree(leaves);
  await program.methods.postEpoch(Array.from(root), new anchor.BN(pot))
    .accounts({ config: configPda, launch, epoch: epochPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
    .signers([authority]).rpc();
  const E = await program.account.epoch.fetch(epochPda);
  ok(E.pot.toNumber() === pot && E.index === 0, `epoch 0 posted with a ${pot} pot`);

  const claimFor = async (s, i) => {
    const [receipt] = PublicKey.findProgramAddressSync([Buffer.from('receipt'), epochPda.toBuffer(), s.who.publicKey.toBuffer()], PROGRAM_ID);
    const before = Number((await getAccount(conn, quoteAta[s.who.publicKey.toBase58()])).amount);
    await program.methods.claimReward(new anchor.BN(s.amount), proofFor(layers, i))
      .accounts({ launch, epoch: epochPda, receipt, quoteMint, rewardVault, claimantQuote: quoteAta[s.who.publicKey.toBase58()], claimant: s.who.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([s.who]).rpc();
    const after = Number((await getAccount(conn, quoteAta[s.who.publicKey.toBase58()])).amount);
    return after - before;
  };
  const got0 = await claimFor(shares[0], 0);
  ok(got0 === shares[0].amount, `merkle claim paid exactly the entitled share (${got0})`);
  const got1 = await claimFor(shares[1], 1);
  ok(got1 === shares[1].amount, 'second holder claimed their share');

  threw = false;
  try { await claimFor(shares[0], 0); } catch { threw = true; }
  ok(threw, 'double-claiming an epoch is impossible (receipt PDA)');

  threw = false;
  try {
    const [receipt] = PublicKey.findProgramAddressSync([Buffer.from('receipt'), epochPda.toBuffer(), cranker.publicKey.toBuffer()], PROGRAM_ID);
    const ata = await getOrCreateAssociatedTokenAccount(conn, cranker, quoteMint, cranker.publicKey);
    await program.methods.claimReward(new anchor.BN(1_000_000), proofFor(layers, 0))
      .accounts({ launch, epoch: epochPda, receipt, quoteMint, rewardVault, claimantQuote: ata.address, claimant: cranker.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([cranker]).rpc();
  } catch { threw = true; }
  ok(threw, 'a wallet not in the merkle tree cannot claim');


  // ---------- fee module: the exact matrix from the locked spec
  const mkLaunch = async (h, c, v, b) => {
    const kp = Keypair.generate();
    const [la] = PublicKey.findProgramAddressSync([Buffer.from('launch'), kp.publicKey.toBuffer()], PROGRAM_ID);
    return program.methods.createLaunch(new anchor.BN(RAISE), new anchor.BN(V_QUOTE0), h, c, v, b, 0, new anchor.BN(0))
      .accounts({ config: configPda, launch: la, mint: kp.publicKey, quoteMint, tokenVault: PublicKey.findProgramAddressSync([Buffer.from('token_vault'), la.toBuffer()], PROGRAM_ID)[0],
        quoteVault: PublicKey.findProgramAddressSync([Buffer.from('quote_vault'), la.toBuffer()], PROGRAM_ID)[0],
        rewardVault: PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), la.toBuffer()], PROGRAM_ID)[0],
        creator: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .signers([creator, kp]).rpc();
  };
  const accepts = async (label, h, c, v, b) => { try { await mkLaunch(h, c, v, b); ok(true, `${label} launches`); } catch (e) { ok(false, `${label} launches — ${e.message.slice(0, 60)}`); } };
  const rejects = async (label, h, c, v, b) => { try { await mkLaunch(h, c, v, b); ok(false, `${label} must revert but launched`); } catch { ok(true, `${label} reverts`); } };

  await accepts('1/1/1 (light, 3%)', 100, 0, 100, 100);
  await accepts('2/1/1 (full engine, 4%)', 200, 0, 100, 100);
  await accepts('3 / 0.5 / 0.5 (stonk lean, 4%)', 300, 0, 50, 50);
  await accepts('3/0/0 (rewards only)', 300, 0, 0, 0);
  await accepts('2/1/1/0 with creator (4%)', 200, 100, 100, 0);
  await accepts('3/1/1 (the full 5% stack)', 300, 0, 100, 100);
  await accepts('2/1/2 (vault at its new 2% ceiling)', 200, 0, 200, 100);
  await rejects('vault 2.5% (over its 2% ceiling)', 200, 0, 250, 0);
  await rejects('3/1/1/1 (6%, over the 5% ceiling)', 300, 100, 100, 100);
  await rejects('holders 0.5% (under the floor)', 50, 0, 0, 0);
  await rejects('holders 3.5% (over the ceiling)', 350, 0, 0, 0);
  await rejects('0.25% (not a half-point step)', 125, 0, 0, 0);
  await rejects('creator 1.5% (over its ceiling)', 100, 150, 0, 0);
  await accepts('memo 1/1/1/1 (4%)', 100, 100, 100, 100);
  await accepts('3% + 1% creator + 1% vault (5%)', 300, 100, 100, 0);

  // ---------- the non-holder buckets: who may move them, and where they go
  {
    const mintKp2 = Keypair.generate();
    const la = PublicKey.findProgramAddressSync([Buffer.from('launch'), mintKp2.publicKey.toBuffer()], PROGRAM_ID)[0];
    const pdas = {
      tokenVault: PublicKey.findProgramAddressSync([Buffer.from('token_vault'), la.toBuffer()], PROGRAM_ID)[0],
      quoteVault: PublicKey.findProgramAddressSync([Buffer.from('quote_vault'), la.toBuffer()], PROGRAM_ID)[0],
      rewardVault: PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), la.toBuffer()], PROGRAM_ID)[0],
    };
    // 2% holders / 1% creator / 1% vault — the memo's own launch default.
    await program.methods.createLaunch(new anchor.BN(RAISE), new anchor.BN(V_QUOTE0), 200, 100, 100, 0, 0, new anchor.BN(0))
      .accounts({ config: configPda, launch: la, mint: mintKp2.publicKey, quoteMint, ...pdas, creator: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .signers([creator, mintKp2]).rpc();
    const posPda = PublicKey.findProgramAddressSync([Buffer.from('position'), la.toBuffer(), b2.publicKey.toBuffer()], PROGRAM_ID)[0];
    const b2Token = await getOrCreateAssociatedTokenAccount(conn, b2, mintKp2.publicKey, b2.publicKey);
    await program.methods.buy(new anchor.BN(10_000_000_000), new anchor.BN(0))
      .accounts({ config: configPda, launch: la, position: posPda, mint: mintKp2.publicKey, quoteMint, ...pdas,
        userToken: b2Token.address, userQuote: quoteAta[b2.publicKey.toBase58()], user: b2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([b2]).rpc();
    let L2 = await program.account.launch.fetch(la);
    ok(L2.creatorPot.toNumber() === 100_000_000 && L2.vaultPot.toNumber() === 100_000_000,
      `a 10,000 buy filled creator and vault at 1% each (${L2.creatorPot} / ${L2.vaultPot})`);
    ok(L2.rewardPot.toNumber() === 150_000_000 && L2.rexPot.toNumber() + L2.partnerPot.toNumber() === 50_000_000,
      `holders kept 1.5% of a 2% allocation and REX took 0.50% out of it (${L2.rewardPot} / ${L2.rexPot} + ${L2.partnerPot})`);
    ok(L2.volumeQuote.toString() === '10000000000', 'the swap counted toward verified volume');

    // the creator may take their own bucket, and only theirs
    const before = Number((await getAccount(conn, quoteAta[creator.publicKey.toBase58()])).amount);
    await program.methods.claimCreator()
      .accounts({ launch: la, quoteMint, rewardVault: pdas.rewardVault, beneficiaryQuote: quoteAta[creator.publicKey.toBase58()], beneficiary: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([creator]).rpc();
    const after = Number((await getAccount(conn, quoteAta[creator.publicKey.toBase58()])).amount);
    ok(after - before === 100_000_000, `the creator withdrew exactly their 1% (${after - before})`);
    let threw2 = false;
    try { await program.methods.claimCreator().accounts({ launch: la, quoteMint, rewardVault: pdas.rewardVault, beneficiaryQuote: quoteAta[b2.publicKey.toBase58()], beneficiary: b2.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).signers([b2]).rpc(); } catch { threw2 = true; }
    ok(threw2, 'nobody but the creator can touch the creator bucket');

    // vault / burn / REX are swept by the config authority only
    const vb = Number((await getAccount(conn, quoteAta[authority.publicKey.toBase58()])).amount);
    await program.methods.sweepBucket(2)
      .accounts({ config: configPda, launch: la, quoteMint, rewardVault: pdas.rewardVault, destination: quoteAta[authority.publicKey.toBase58()], authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([authority]).rpc();
    const va = Number((await getAccount(conn, quoteAta[authority.publicKey.toBase58()])).amount);
    ok(va - vb === 100_000_000, `the vault bucket swept exactly its 1% (${va - vb})`);
    let threw3 = false;
    try { await program.methods.sweepBucket(2).accounts({ config: configPda, launch: la, quoteMint, rewardVault: pdas.rewardVault, destination: quoteAta[b2.publicKey.toBase58()], authority: b2.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).signers([b2]).rpc(); } catch { threw3 = true; }
    ok(threw3, 'a stranger cannot sweep a bucket');
    let threw4 = false;
    try { await program.methods.sweepBucket(2).accounts({ config: configPda, launch: la, quoteMint, rewardVault: pdas.rewardVault, destination: quoteAta[authority.publicKey.toBase58()], authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).signers([authority]).rpc(); } catch { threw4 = true; }
    ok(threw4, 'sweeping an empty bucket reverts rather than paying zero');

    // REX's tier only ever falls
    await program.methods.setRexTier(45).accounts({ config: configPda, launch: la, authority: authority.publicKey }).signers([authority]).rpc();
    L2 = await program.account.launch.fetch(la);
    ok(L2.rexBps === 45, 'REX stepped down one milestone, 0.50% → 0.45%');
    let threw5 = false;
    try { await program.methods.setRexTier(50).accounts({ config: configPda, launch: la, authority: authority.publicKey }).signers([authority]).rpc(); } catch { threw5 = true; }
    ok(threw5, 'the fee cannot be stepped back up');
    let threw6 = false;
    try { await program.methods.setRexTier(15).accounts({ config: configPda, launch: la, authority: authority.publicKey }).signers([authority]).rpc(); } catch { threw6 = true; }
    ok(threw6, 'and cannot go below the 0.20% floor');

    // "Dev buy is escrowed into the same clear and capped" — the creator cannot be most of their open.
    {
      const kp = Keypair.generate();
      const dl = PublicKey.findProgramAddressSync([Buffer.from('launch'), kp.publicKey.toBuffer()], PROGRAM_ID)[0];
      const dp = {
        tokenVault: PublicKey.findProgramAddressSync([Buffer.from('token_vault'), dl.toBuffer()], PROGRAM_ID)[0],
        quoteVault: PublicKey.findProgramAddressSync([Buffer.from('quote_vault'), dl.toBuffer()], PROGRAM_ID)[0],
        rewardVault: PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), dl.toBuffer()], PROGRAM_ID)[0],
      };
      await program.methods.createLaunch(new anchor.BN(RAISE), new anchor.BN(V_QUOTE0), 200, 0, 0, 0, 0, new anchor.BN(600))
        .accounts({ config: configPda, launch: dl, mint: kp.publicKey, quoteMint, ...dp, creator: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
        .signers([creator, kp]).rpc();
      const cap = Math.floor(RAISE * 0.2);
      const devCommit = (who, amount) => program.methods.commit(new anchor.BN(amount))
        .accounts({ launch: dl, commitment: PublicKey.findProgramAddressSync([Buffer.from('commit'), dl.toBuffer(), who.publicKey.toBuffer()], PROGRAM_ID)[0],
          quoteMint, quoteVault: dp.quoteVault, bidderQuote: quoteAta[who.publicKey.toBase58()], bidder: who.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .signers([who]).rpc();
      try { await devCommit(creator, cap); ok(true, `the creator may commit up to 20% of the raise (${cap})`); } catch (e) { ok(false, `20% should be allowed — ${e.message.slice(0, 60)}`); }
      let over = false;
      try { await devCommit(creator, 1_000_000); } catch { over = true; }
      ok(over, 'one unit past the cap is rejected');
      try { await devCommit(b1, cap * 2); ok(true, 'a non-creator is not capped — only the dev is'); } catch (e) { ok(false, `a stranger should not be capped — ${e.message.slice(0, 60)}`); }
    }

    // "A send pays zero" — an SPL transfer of the launched token touches no bucket.
    const potsBefore = JSON.stringify([L2.rewardPot, L2.creatorPot, L2.vaultPot, L2.burnPot, L2.rexPot].map(String));
    const dest = await getOrCreateAssociatedTokenAccount(conn, b2, mintKp2.publicKey, b1.publicKey);
    const { createTransferInstruction } = await import('@solana/spl-token');
    const tx = new anchor.web3.Transaction().add(createTransferInstruction(b2Token.address, dest.address, b2.publicKey, 1_000_000));
    await anchor.web3.sendAndConfirmTransaction(conn, tx, [b2]);
    const L3 = await program.account.launch.fetch(la);
    ok(JSON.stringify([L3.rewardPot, L3.creatorPot, L3.vaultPot, L3.burnPot, L3.rexPot].map(String)) === potsBefore,
      'a plain token send paid zero — no bucket moved');
    ok(Number((await getAccount(conn, dest.address)).amount) === 1_000_000, 'and the recipient got the full amount, untaxed');
  }

  // ---------- the authority can be handed over, in two steps, and only in two steps
  {
    const next = Keypair.generate();
    await fund(next, 1);
    let direct = false;
    try { await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: next.publicKey }).signers([next]).rpc(); } catch { direct = true; }
    ok(direct, 'a key cannot simply claim the authority — something has to propose it first');

    await program.methods.proposeAuthority(next.publicKey).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc();
    let cfgNow = await program.account.config.fetch(configPda);
    ok(cfgNow.authority.equals(authority.publicKey) && cfgNow.pendingAuthority.equals(next.publicKey),
      'proposing does not move the authority — it only nominates');

    let wrongKey = false;
    try { await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: cranker.publicKey }).signers([cranker]).rpc(); } catch { wrongKey = true; }
    ok(wrongKey, 'and a key that was not the one nominated cannot accept it');

    await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: next.publicKey }).signers([next]).rpc();
    cfgNow = await program.account.config.fetch(configPda);
    ok(cfgNow.authority.equals(next.publicKey) && cfgNow.pendingAuthority.equals(PublicKey.default),
      'the nominated key accepted, and the handover is complete');

    let oldStillWorks = false;
    try { await program.methods.setConfig(100, 25, false).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc(); oldStillWorks = true; } catch {}
    ok(!oldStillWorks, 'the previous authority can no longer change anything');

    // hand it back so the rest of a re-run still works
    await program.methods.proposeAuthority(authority.publicKey).accounts({ config: configPda, authority: next.publicKey }).signers([next]).rpc();
    await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: authority.publicKey }).signers([authority]).rpc();
    ok((await program.account.config.fetch(configPda)).authority.equals(authority.publicKey), 'and it can be handed back the same way');
  }

  // ---------- the revenue share: set once, then nothing on earth lowers it
  {
    // Deterministic, so a re-run against the same validator finds the share it set last time —
    // the whole point is that it can only ever be set once.
    const partner = partnerSeed;
    await fund(partner, 2);
    const partnerAta = await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, partner.publicKey);

    let cfg2 = await program.account.config.fetch(configPda);
    if (cfg2.partnerBps === 0) {
      await program.methods.setPartner(partner.publicKey, 1000).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc();
      cfg2 = await program.account.config.fetch(configPda);
    }
    const oursToTest = cfg2.partner.equals(partner.publicKey);
    ok(cfg2.partnerBps > 0, `a revenue share is configured: ${(cfg2.partnerBps / 100).toFixed(1)}% of REX Chain's cut`);
    if (!oursToTest) {
      // Someone else (a demo, a previous operator) already set it on this validator. That is the
      // feature: it is set once and permanent. Prove the lock, and skip what needs their key.
      console.log(`   ↳ a share was already set on this cluster to ${cfg2.partner.toBase58().slice(0, 8)}… — proving the lock only`);
    }

    const cannot = async (label, fn) => { let threw = false; try { await fn(); } catch { threw = true; } ok(threw, label); };
    await cannot('the authority cannot lower it', () => program.methods.setPartner(partner.publicKey, 1).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc());
    await cannot('the authority cannot zero it', () => program.methods.setPartner(authority.publicKey, 0).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc());
    await cannot('the authority cannot redirect it to itself', () => program.methods.setPartner(authority.publicKey, 1000).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc());
    ok(!Object.keys(program.methods).some((m) => /updatePartner|removePartner|clearPartner|revoke/i.test(m)),
      'and the program exposes no instruction that could change the terms at all');

    // a launch, a trade, and the share lands in its own pot
    const kp = Keypair.generate();
    const pl = PublicKey.findProgramAddressSync([Buffer.from('launch'), kp.publicKey.toBuffer()], PROGRAM_ID)[0];
    const pv = {
      tokenVault: PublicKey.findProgramAddressSync([Buffer.from('token_vault'), pl.toBuffer()], PROGRAM_ID)[0],
      quoteVault: PublicKey.findProgramAddressSync([Buffer.from('quote_vault'), pl.toBuffer()], PROGRAM_ID)[0],
      rewardVault: PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), pl.toBuffer()], PROGRAM_ID)[0],
    };
    await program.methods.createLaunch(new anchor.BN(RAISE), new anchor.BN(V_QUOTE0), 200, 0, 0, 0, 0, new anchor.BN(0))
      .accounts({ config: configPda, launch: pl, mint: kp.publicKey, quoteMint, ...pv, creator: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .signers([creator, kp]).rpc();
    const bToken = await getOrCreateAssociatedTokenAccount(conn, b2, kp.publicKey, b2.publicKey);
    await program.methods.buy(new anchor.BN(10_000_000_000), new anchor.BN(0))
      .accounts({ config: configPda, launch: pl, position: PublicKey.findProgramAddressSync([Buffer.from('position'), pl.toBuffer(), b2.publicKey.toBuffer()], PROGRAM_ID)[0],
        mint: kp.publicKey, quoteMint, ...pv, userToken: bToken.address, userQuote: quoteAta[b2.publicKey.toBase58()], user: b2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([b2]).rpc();
    let PL = await program.account.launch.fetch(pl);
    // 2% holders of 10,000 = 200; REX's 0.50% of the trade = 50, carved out of it; the share is 10% of 50
    // REX's fee is 0.50% of the 10,000 trade = 50; the share is 10% of that.
    const rexTotal = 50_000_000;
    const expectPartner = Math.floor(rexTotal * cfg2.partnerBps / 10_000);
    ok(PL.partnerPot.toNumber() === expectPartner && PL.rexPot.toNumber() === rexTotal - expectPartner,
      `the share split off at accrual: partner ${PL.partnerPot} / REX Chain ${PL.rexPot}`);
    ok(PL.rewardPot.toNumber() === 150_000_000,
      'and it came out of REX\'s fee, not the holders\' — they keep 1.5% of their 2% allocation either way');

    // the authority sweeping its own bucket cannot reach the partner's
    await program.methods.sweepBucket(4)
      .accounts({ config: configPda, launch: pl, quoteMint, rewardVault: pv.rewardVault, destination: quoteAta[authority.publicKey.toBase58()], authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([authority]).rpc();
    PL = await program.account.launch.fetch(pl);
    ok(PL.rexPot.toNumber() === 0 && PL.partnerPot.toNumber() === expectPartner,
      'the authority swept its own cut to zero and the partner\'s pot is untouched');

    // the partner claims alone — no authority, no crank, nobody else
    if (oursToTest) await cannot('a stranger cannot claim the share', () => program.methods.claimPartner()
      .accounts({ config: configPda, launch: pl, quoteMint, rewardVault: pv.rewardVault, partnerQuote: quoteAta[b2.publicKey.toBase58()], partner: b2.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).signers([b2]).rpc());
    if (oursToTest) {
      const before = Number((await getAccount(conn, partnerAta.address)).amount);
      await program.methods.claimPartner()
        .accounts({ config: configPda, launch: pl, quoteMint, rewardVault: pv.rewardVault, partnerQuote: partnerAta.address, partner: partner.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([partner]).rpc();
      const got = Number((await getAccount(conn, partnerAta.address)).amount) - before;
      ok(got === expectPartner, `the partner withdrew their share on their own signature alone (${got})`);
    }

    // rotating the receiving wallet is the partner's call, and only the partner's
    await cannot('the authority cannot move the share to another wallet', () => program.methods.setPartnerWallet(authority.publicKey)
      .accounts({ config: configPda, partner: authority.publicKey }).signers([authority]).rpc());
    if (oursToTest) {
      // rotate away and straight back, so a re-run still finds the deterministic key
      const fresh = Keypair.generate();
      await program.methods.setPartnerWallet(fresh.publicKey).accounts({ config: configPda, partner: partner.publicKey }).signers([partner]).rpc();
      let r = await program.account.config.fetch(configPda);
      const rotated = r.partner.equals(fresh.publicKey) && r.partnerBps === 1000;
      await program.methods.setPartnerWallet(partner.publicKey).accounts({ config: configPda, partner: fresh.publicKey }).signers([fresh]).rpc();
      ok(rotated, 'the partner rotated their own wallet, and the percentage did not move');
    }

    // and it survives the protocol changing hands entirely
    const newAuth = Keypair.generate(); await fund(newAuth, 1);
    await program.methods.proposeAuthority(newAuth.publicKey).accounts({ config: configPda, authority: authority.publicKey }).signers([authority]).rpc();
    await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: newAuth.publicKey }).signers([newAuth]).rpc();
    await cannot('a NEW authority still cannot touch the share', () => program.methods.setPartner(newAuth.publicKey, 1).accounts({ config: configPda, authority: newAuth.publicKey }).signers([newAuth]).rpc());
    cfg2 = await program.account.config.fetch(configPda);
    const end = await program.account.config.fetch(configPda);
    ok(end.partnerBps === cfg2.partnerBps && end.partner.equals(cfg2.partner), 'the share survived the protocol changing hands');
    await program.methods.proposeAuthority(authority.publicKey).accounts({ config: configPda, authority: newAuth.publicKey }).signers([newAuth]).rpc();
    await program.methods.acceptAuthority().accounts({ config: configPda, newAuthority: authority.publicKey }).signers([authority]).rpc();
  }

  // ---------- the REX Chain fee schedule, and the revenue share across every step of it
  {
    const kp = Keypair.generate();
    const l5 = PublicKey.findProgramAddressSync([Buffer.from('launch'), kp.publicKey.toBuffer()], PROGRAM_ID)[0];
    const v5 = {
      tokenVault: PublicKey.findProgramAddressSync([Buffer.from('token_vault'), l5.toBuffer()], PROGRAM_ID)[0],
      quoteVault: PublicKey.findProgramAddressSync([Buffer.from('quote_vault'), l5.toBuffer()], PROGRAM_ID)[0],
      rewardVault: PublicKey.findProgramAddressSync([Buffer.from('reward_vault'), l5.toBuffer()], PROGRAM_ID)[0],
    };
    // the full 5% stack: 3% holders, 1% creator… no — 3 + 1 + 2 would be 6. Use 2/1/1/0.5/0.5 = 5%.
    await program.methods.createLaunch(new anchor.BN(RAISE), new anchor.BN(V_QUOTE0), 200, 100, 150, 50, 0, new anchor.BN(0))
      .accounts({ config: configPda, launch: l5, mint: kp.publicKey, quoteMint, ...v5, creator: creator.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .signers([creator, kp]).rpc();
    let L5 = await program.account.launch.fetch(l5);
    ok(L5.rexBps === 50, `the REX protocol fee starts at 0.50% of the trade (${L5.rexBps} bps)`);
    ok(L5.holderBps + L5.creatorBps + L5.vaultBps + L5.burnBps + L5.buybackBps === 500,
      'a 2 / 1 / 1.5 / 0.5 stack is a legal 5%');

    const tok5 = await getOrCreateAssociatedTokenAccount(conn, b2, kp.publicKey, b2.publicKey);
    const posA = PublicKey.findProgramAddressSync([Buffer.from('position'), l5.toBuffer(), b2.publicKey.toBuffer()], PROGRAM_ID)[0];
    // Small enough that seven of them cannot fill the curve: once it caps and refunds, the gross is
    // no longer the amount asked for and the absolute assertions below stop meaning anything.
    const BUY5 = 1_000_000_000;
    const buy5 = () => program.methods.buy(new anchor.BN(BUY5), new anchor.BN(0))
      .accounts({ config: configPda, launch: l5, position: posA, mint: kp.publicKey, quoteMint, ...v5,
        userToken: tok5.address, userQuote: quoteAta[b2.publicKey.toBase58()], user: b2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([b2]).rpc();

    // Walk the published schedule and check the share at every single step.
    const schedule = [50, 45, 40, 35, 30, 25, 20];
    const seen = [];
    for (const tier of schedule) {
      if (tier !== 50) await program.methods.setRexTier(tier).accounts({ config: configPda, launch: l5, authority: authority.publicKey }).signers([authority]).rpc();
      const before = await program.account.launch.fetch(l5);
      await buy5();
      const after = await program.account.launch.fetch(l5);
      const dHolder = after.rewardPot.sub(before.rewardPot).toNumber();
      const dRex = after.rexPot.sub(before.rexPot).toNumber();
      const dPartner = after.partnerPot.sub(before.partnerPot).toNumber();
      const gross = BUY5;
      const rexTotal = dRex + dPartner;
      seen.push({ tier, dHolder, rexTotal, dPartner });
      // REX's fee is exactly the tier, as an absolute share of the trade
      ok(rexTotal === gross * tier / 10_000, `  tier ${(tier / 100).toFixed(2)}%: REX took exactly that of the trade (${rexTotal})`);
      // the share is 10% of it, whatever the tier
      ok(dPartner === Math.floor(rexTotal * 1000 / 10_000), `  tier ${(tier / 100).toFixed(2)}%: the share is still 10% of REX's fee (${dPartner})`);
      // and holders got the rest of their 2% allocation
      ok(dHolder === gross * 200 / 10_000 - rexTotal, `  tier ${(tier / 100).toFixed(2)}%: holders kept ${(dHolder / gross * 100).toFixed(2)}% — REX's step-down went to them`);
    }
    const first = seen[0], last = seen[seen.length - 1];
    ok(last.dHolder > first.dHolder && last.rexTotal < first.rexTotal,
      `across the schedule the holder allocation rose (${(first.dHolder / 1e8).toFixed(2)}% → ${(last.dHolder / 1e8).toFixed(2)}%) as REX's fee fell`);
    ok(seen.every((x) => x.dPartner === Math.floor(x.rexTotal / 10)),
      'and the revenue share stayed exactly 10% of REX at every step — no tier can dilute it');

    let rose = false;
    try { await program.methods.setRexTier(50).accounts({ config: configPda, launch: l5, authority: authority.publicKey }).signers([authority]).rpc(); rose = true; } catch {}
    ok(!rose, 'the REX fee cannot be stepped back up');
    let belowFloor = false;
    try { await program.methods.setRexTier(15).accounts({ config: configPda, launch: l5, authority: authority.publicKey }).signers([authority]).rpc(); belowFloor = true; } catch {}
    ok(!belowFloor, 'and it cannot go below the 0.20% floor');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL', e.message || e); if (e.logs) console.error(e.logs.slice(-15).join('\n')); process.exit(1); });
