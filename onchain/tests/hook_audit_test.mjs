// Proof that the two HOOK findings in REX-TECHNICAL-DISCLOSURE-2026-10-12 are closed.
//
// ⛔ NEITHER PATH HAD ANY TEST COVERAGE AT ALL, which is a large part of why both survived review.
// `tests/e2e.mjs` never calls initialize, freeze or renounce.
//
//   solana-test-validator -r --bpf-program <rexhook id> target/deploy/rexhook.so
//   node tests/hook_audit_test.mjs
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createMint, TOKEN_2022_PROGRAM_ID, getMintLen, ExtensionType,
  createInitializeTransferHookInstruction, createInitializeMintInstruction,
} from '@solana/spl-token';
import { Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'node:fs';

const RPC = process.env.RPC || 'http://127.0.0.1:8899';
const conn = new Connection(RPC, 'confirmed');
const idl = JSON.parse(fs.readFileSync(new URL('../target/idl/rexhook.json', import.meta.url)));
const PROGRAM_ID = new PublicKey(idl.address);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const errText = (e) => `${e?.error?.errorMessage || ''} ${e?.message || ''} ${JSON.stringify(e?.logs || [])}`;

const payer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
const wallet = new anchor.Wallet(payer);
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);

/** A Token-2022 mint whose transfer-hook extension points at this program. */
async function makeHookedMint(mintAuthority) {
  const mint = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferHook]);
  const lamports = await conn.getMinimumBalanceForRentExemption(len);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      space: len, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mint.publicKey, mintAuthority.publicKey, PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 6, mintAuthority.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, tx, [payer, mint], { commitment: 'confirmed' });
  return mint.publicKey;
}
const pdas = (mint) => ({
  rules: PublicKey.findProgramAddressSync([Buffer.from('rules'), mint.toBuffer()], PROGRAM_ID)[0],
  meta: PublicKey.findProgramAddressSync([Buffer.from('extra-account-metas'), mint.toBuffer()], PROGRAM_ID)[0],
});
// max_wallet, guard_secs, guard_max_wallet. The guard window has to be genuinely open or `freeze`
// refuses with GuardOver and the HOOK-01 case cannot be set up at all.
const initArgs = () => [new anchor.BN(0), new anchor.BN(3600), new anchor.BN(0)];

async function initialize(mint, authority) {
  const p = pdas(mint);
  const m = program.methods.initialize ? program.methods : null;
  if (!m) throw new Error('no initialize method on the IDL');
  const args = initArgs();
  return program.methods.initialize(...args)
    .accounts({ payer: payer.publicKey, authority: authority.publicKey, mint,
      rules: p.rules, extraAccountMetaList: p.meta, systemProgram: SystemProgram.programId })
    .signers(authority.publicKey.equals(payer.publicKey) ? [] : [authority])
    .rpc();
}

// ── HOOK-02: initialize must be unavailable to anyone but the mint's own authority ──────────────
{
  const creator = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(creator.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  const mint = await makeHookedMint(creator);
  const stranger = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), 'confirmed');

  let blocked = false, why = '';
  try { await initialize(mint, stranger); } catch (e) { blocked = true; why = errText(e); }
  ok(blocked, '⛔ HOOK-02: a stranger cannot claim a new mint\'s rules');
  ok(/NotMintAuthority|only the mint/i.test(why), `   and it is refused for the right reason${blocked ? '' : ' (n/a)'}`);

  await initialize(mint, creator);
  const r = await program.account.hookRules.fetch(pdas(mint).rules);
  ok(r.authority.equals(creator.publicKey), '   while the mint\'s own authority still succeeds');
}

// ── HOOK-01: freeze then renounce must not be reachable ─────────────────────────────────────────
{
  const creator = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(creator.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  const mint = await makeHookedMint(creator);
  await initialize(mint, creator);
  const p = pdas(mint);

  await program.methods.freeze().accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  const frozen = await program.account.hookRules.fetch(p.rules);
  ok(frozen.frozen === true, 'a hooked mint can still be frozen inside the guard window');

  let blocked = false, why = '';
  try {
    await program.methods.renounce().accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  } catch (e) { blocked = true; why = errText(e); }
  ok(blocked, '⛔ HOOK-01: renounce is refused while frozen — the one combination with no way back');
  ok(/Frozen|transfers are halted/i.test(why), '   and it is refused for the right reason');

  // The escape hatch still works: thaw, then renounce.
  await program.methods.thaw().accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  await program.methods.renounce().accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  const done = await program.account.hookRules.fetch(p.rules);
  ok(done.authority.equals(PublicKey.default), '   and thaw-then-renounce still gives up control as intended');
}

// ── HOOK-03: the wallet cap must not apply to program vaults ────────────────────────────────────
//
// ⛔ "THE LAUNCH WORKS UNTIL IT IS POPULAR, THEN HALTS." `max_wallet` was checked against every
// destination's whole post-transfer balance with no exception, and a launchpad's vaults are
// destinations that accumulate everyone's deposits by design — so a cap sized for a retail wallet
// is passed by a vault almost immediately and every subsequent transfer into it reverts.
{
  const creator = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(creator.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  const mint = await makeHookedMint(creator);
  await initialize(mint, creator);
  const p = pdas(mint);
  const vault = Keypair.generate().publicKey;

  await program.methods.exemptAdd(vault).accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  let r = await program.account.hookRules.fetch(p.rules);
  ok(r.exempt.some((k) => k.equals(vault)), '⛔ HOOK-03: a vault authority can be exempted from the wallet cap');
  ok(r.exempt.length === 1, '   and only the one entry is added');

  // Adding twice must not duplicate — the list is small and a duplicate wastes a slot.
  await program.methods.exemptAdd(vault).accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  r = await program.account.hookRules.fetch(p.rules);
  ok(r.exempt.length === 1, '   adding the same authority twice does not duplicate it');

  // Removing TIGHTENS, so it follows the same guard-window rule as `block`.
  await program.methods.exemptRemove(vault).accounts({ authority: creator.publicKey, rules: p.rules }).signers([creator]).rpc();
  r = await program.account.hookRules.fetch(p.rules);
  ok(r.exempt.length === 0, '   and it can be removed inside the guard window');

  // The existing rules are untouched by the new field.
  ok(r.frozen === false && r.blocked.length === 0 && r.mint.equals(mint),
    '   while the rest of the rules account still reads back correctly');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
