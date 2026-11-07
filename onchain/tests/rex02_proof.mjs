// REX-02: the migration snapshot, and the upgrade path for launches written before it existed.
//
// ⛔ TWO THINGS HAVE TO BE TRUE AND ONLY ONE OF THEM IS ABOUT THE FINDING. The finding is that
// `pool_vault >= released` proves a pool holds enough, not that this migration filled it — closed
// by snapshotting the vaults at release, pinning the pool, and requiring the delta at confirm. The
// other is that those three new fields take a Launch from 302 bytes to 350, and Anchor's
// `Account<Launch>` fails Borsh outright on a short account: every launch written before this
// upgrade is untradeable until `migrate_launch` grows it. Three accounts on mainnet today, so that
// is three transactions — but it is a step that has to exist and has to be rehearsed, not assumed.
//
//   solana-test-validator -r --bpf-program <rexpad id> target/deploy/rexpad.so
//   node tests/rex02_proof.mjs
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'node:fs';

const conn = new Connection(process.env.RPC || 'http://127.0.0.1:8899', 'confirmed');
const idl = JSON.parse(fs.readFileSync(new URL('../target/idl/rexpad.json', import.meta.url)));
const PROGRAM_ID = new PublicKey('2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const payer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: 'confirmed' });
const program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);

// ── the realloc path, exercised against an account written at the OLD size ──────────────────────
// Stand one up by hand at 302 bytes owned by the program, which is exactly what mainnet holds.
const OLD = 302, NEW = 8 + 350 - 8;   // the struct the current program expects, minus nothing
const fake = Keypair.generate();
{
  const lamports = await conn.getMinimumBalanceForRentExemption(OLD);
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: fake.publicKey,
      space: OLD, lamports, programId: PROGRAM_ID }),
  );
  await anchor.web3.sendAndConfirmTransaction(conn, tx, [payer, fake], { commitment: 'confirmed' });
  const before = await conn.getAccountInfo(fake.publicKey);
  ok(before.data.length === OLD, `a launch written before this upgrade is ${before.data.length} bytes`);
  ok(before.owner.equals(PROGRAM_ID), '   and owned by the program, as mainnet\'s three are');

  await program.methods.migrateLaunch()
    .accounts({ launch: fake.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  const after = await conn.getAccountInfo(fake.publicKey);
  ok(after.data.length > OLD, `⛔ migrate_launch grew it to ${after.data.length} bytes`);
  ok(after.data.slice(OLD).every((b) => b === 0),
    '   and the added bytes are zero — "no release in flight", which is the correct starting state');

  // Idempotent: running it twice must not error or charge again.
  await program.methods.migrateLaunch()
    .accounts({ launch: fake.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  const twice = await conn.getAccountInfo(fake.publicKey);
  ok(twice.data.length === after.data.length, 'running it a second time is a no-op, not an error');
}

// ── and it refuses an account this program does not own ─────────────────────────────────────────
{
  const stranger = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  let refused = false;
  try {
    await program.methods.migrateLaunch()
      .accounts({ launch: stranger.publicKey, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  } catch { refused = true; }
  ok(refused, '⛔ it refuses an account the program does not own — nobody funds a stranger\'s rent');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
