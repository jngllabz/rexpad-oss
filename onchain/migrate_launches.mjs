// Grow every pre-upgrade Launch so it fits the current layout. Run IMMEDIATELY after the upgrade.
//
// ⛔ BETWEEN THE UPGRADE LANDING AND THIS FINISHING, THOSE LAUNCHES CANNOT BE TRADED. Three new
// fields take a Launch from 302 bytes to 350, and Anchor's `Account<Launch>` fails Borsh outright
// on a short account — so this is not optional tidying, it is the second half of the deploy. It
// finds the accounts itself rather than trusting a list written earlier, because the set can change
// between now and whenever the upgrade actually ships.
//
//   node onchain/migrate_launches.mjs            # report only
//   node onchain/migrate_launches.mjs --send     # grow them
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, SystemProgram, Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import os from 'node:os';

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const SEND = process.argv.includes('--send');
const idl = JSON.parse(fs.readFileSync(new URL('./target/idl/rexpad.json', import.meta.url)));
const PROGRAM_ID = new PublicKey('2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E');
const conn = new Connection(RPC, 'confirmed');

const keyPath = process.env.SOLANA_KEYPAIR || `${os.homedir()}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: 'confirmed' });
const program = new anchor.Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);

// ⛔ DERIVE THE TARGET SIZE, DO NOT TYPE IT. My first pass wrote `8 + 350` and 350 already included
// the discriminator, so `need` came out at 358: every account would have been reported short even
// after a successful grow, and the verify below would have called a working migration a failure.
const SZ = { pubkey: 32, u128: 16, i128: 16, u64: 8, i64: 8, u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, bool: 1 };
const need = 8 + idl.types.find((t) => t.name === 'Launch').type.fields
  .reduce((a, f) => a + (SZ[typeof f.type === 'string' ? f.type : ''] ?? 1), 0);
const disc = new anchor.BorshAccountsCoder(idl).accountDiscriminator('Launch');
const accs = await conn.getProgramAccounts(PROGRAM_ID, {
  commitment: 'confirmed',
  dataSlice: { offset: 0, length: 0 },
  filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
});
console.log(`launches found: ${accs.length}`);

let short = [];
for (const a of accs) {
  const info = await conn.getAccountInfo(a.pubkey);
  if (info && info.data.length < need) short.push({ key: a.pubkey, was: info.data.length });
}
if (!short.length) { console.log(`✅ every launch is already at least ${need} bytes — nothing to do`); process.exit(0); }
console.log(`${short.length} need growing to ${need} bytes:`);
for (const s of short) console.log(`  ${s.key.toBase58()}  ${s.was}b`);
if (!SEND) { console.log('\n(dry run — pass --send to grow them)'); process.exit(0); }

let done = 0;
for (const s of short) {
  try {
    const sig = await program.methods.migrateLaunch()
      .accounts({ launch: s.key, payer: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const after = await conn.getAccountInfo(s.key);
    // Verify rather than assume: a signature is not a resize.
    if (!after || after.data.length < need) throw new Error(`still ${after?.data.length} bytes`);
    console.log(`  ✅ ${s.key.toBase58()} ${s.was} → ${after.data.length}b  ${sig.slice(0, 12)}…`);
    done++;
  } catch (e) {
    console.log(`  ❌ ${s.key.toBase58()}: ${String(e.message).slice(0, 120)}`);
  }
}
console.log(`\n${done}/${short.length} grown.${done < short.length ? ' ⛔ Re-run — the rest are still untradeable.' : ''}`);
process.exit(done === short.length ? 0 : 1);
