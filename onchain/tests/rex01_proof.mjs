// Execution proof for REX-01, the HIGH finding I had only ever compile-verified.
//
// ⛔ THE WHOLE POINT OF REX-01 IS THAT AN INVARIANT HELD BETWEEN TWO UNCOUPLED INSTRUCTIONS IS NOT
// AN INVARIANT. `migrate_config` validated the five legs against `10_000 - partner_bps`;
// `raise_partner` then moved `partner_bps` without touching them, and `distribute` divided by the
// new share while cutting the old legs — 107.78% of the bucket at the 300 → 1000 bps change the
// code's own comment said was coming. Reading the patch is not the same as watching the program
// refuse, so this watches it refuse.
//
//   solana-test-validator -r --bpf-program <rexpad id> target/deploy/rexpad.so
//   node tests/rex01_proof.mjs
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'node:fs';

const conn = new Connection(process.env.RPC || 'http://127.0.0.1:8899', 'confirmed');
const idl = JSON.parse(fs.readFileSync(new URL('../target/idl/rexpad.json', import.meta.url)));
const PROGRAM_ID = new PublicKey('2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const why = (e) => `${e?.error?.errorCode?.code || ''} ${e?.error?.errorMessage || e?.message || ''}`;

const authority = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: 'confirmed' });
const program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);

const partner = Keypair.generate().publicKey;
await program.methods.initConfig(100, 25, partner, 300)
  .accounts({ config: configPda, authority: authority.publicKey, feeWallet: authority.publicKey,
    systemProgram: SystemProgram.programId })
  .rpc();
let cfg = await program.account.config.fetch(configPda);
ok(cfg.partnerBps === 300, 'config starts at the 300 bps the code comment calls the mistake');

// Write legs that sum to 10_000 - 300 = 9_700, which is what migrate_config demands today.
const w = () => Keypair.generate().publicKey;
const legs = { dev2: w(), dev2Bps: 2000, buyback: w(), buybackBps: 6200, usdcReserve: w(), usdcBps: 500,
               plays: w(), playsBps: 500, vault: w(), vaultBps: 500 };
await program.methods.migrateConfig(legs)
  .accounts({ config: configPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
cfg = await program.account.config.fetch(configPda);
const sum = cfg.dev2Bps + cfg.buybackBps + cfg.usdcBps + cfg.playsBps + cfg.vaultBps;
ok(sum === 9700 && Number(cfg.waterfallVersion) > 0,
  `legs sum to ${sum} against a ${10000 - cfg.partnerBps} divisor, waterfall_version ${cfg.waterfallVersion}`);

// ── the change the finding is about ──────────────────────────────────────────────────────────
await program.methods.raisePartner(1000)
  .accounts({ config: configPda, authority: authority.publicKey })
  .rpc();
cfg = await program.account.config.fetch(configPda);
ok(cfg.partnerBps === 1000, 'raise_partner moved the share to 1000 bps');
const stillSum = cfg.dev2Bps + cfg.buybackBps + cfg.usdcBps + cfg.playsBps + cfg.vaultBps;
ok(stillSum === 9700,
  `⛔ and the legs STILL sum to ${stillSum} over a ${10000 - cfg.partnerBps} divisor — ${(stillSum / (10000 - cfg.partnerBps) * 100).toFixed(2)}% of the bucket`);

// THE FIX: the version is cleared, so distribute refuses until the legs are re-migrated.
ok(Number(cfg.waterfallVersion) === 0,
  '⛔ raise_partner cleared waterfall_version — the ordering is now structural, not remembered');

// And re-migrating with legs that match the new divisor restores it.
await program.methods.migrateConfig({ ...legs, buybackBps: 5500 })   // 9_000 total
  .accounts({ config: configPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
cfg = await program.account.config.fetch(configPda);
const fixed = cfg.dev2Bps + cfg.buybackBps + cfg.usdcBps + cfg.playsBps + cfg.vaultBps;
ok(fixed === 9000 && fixed === 10000 - cfg.partnerBps && Number(cfg.waterfallVersion) > 0,
  `re-migrating to ${fixed} against ${10000 - cfg.partnerBps} restores the version (${cfg.waterfallVersion})`);

// And migrate_config still refuses a mismatched set, which is the check that always existed.
let refused = false, msg = '';
try {
  await program.methods.migrateConfig({ ...legs, buybackBps: 6200 })  // 9_700 vs a 9_000 divisor
    .accounts({ config: configPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
} catch (e) { refused = true; msg = why(e); }
ok(refused, '⛔ legs that do not match the divisor are refused outright');
ok(/WaterfallMismatch/.test(msg), `   with WaterfallMismatch — ${msg.trim().slice(0, 60)}`);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
