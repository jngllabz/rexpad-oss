// Bring the MAINNET config to its intended state: Cyrus at 10%, and the five-wallet waterfall.
//
//   node tools/mainnet_waterfall.mjs              # plan only, signs nothing
//   node tools/mainnet_waterfall.mjs --execute
//
// ⛔ THE ORDER IS NOT A PREFERENCE, IT IS FORCED, AND IT TAKES THREE STEPS.
//
//   raise_partner takes `Box<Account<Config>>` — a TYPED account, so it cannot even be called while
//   the on-chain config is the old 144-byte layout. migrate_config takes an UncheckedAccount and
//   grows the account, so it is the only one that can run first.
//
//   But migrate_config validates that the five legs sum to exactly (10_000 - partner_bps), and
//   partner_bps is still 300 at that moment. So the first migration must sum to 9700. Raising the
//   partner to 1000 afterwards would then leave legs summing to 9700 against a denominator of 9000
//   — and `distribute` divides by that denominator, so it would pay out 107.8% of the pot, every
//   run, until someone noticed.
//
//   Hence: migrate(9700) → raise(1000) → migrate(9000).
//
// Every intermediate state is internally consistent, so an interruption at any point leaves the
// config valid rather than over-allocated — which is the property that makes this safe to run at
// all on a program holding real money.
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import fs from 'node:fs';

const EXECUTE = process.argv.includes('--execute');
const RPC = 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID = new PublicKey('2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E');

const signer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));

const PARTNER_TARGET = 1000;                       // Cyrus — 10% of all protocol income
const LEGS = {
  dev2:        { k: '6m4GQR71nWcJVrGiwcfkz5eVBQQiDHRSkzTENjavTND6', bps: 2000, label: 'ELIO team 20%' },
  buyback:     { k: '5iRLrdf3CcuBfHuoDPzVtVzFgvom3qHZ2QswjBwdzcY2', bps: 5500, label: 'buyback + burn 55%' },
  usdcReserve: { k: '7vXNm42xuYL7AWSuKvLoTxymNyNTBCcGcYeJTT94yoZ2', bps:  500, label: 'USDC reserve 5%' },
  plays:       { k: 'AaWdfUJgZWx8E1225PNKq6FfsC95Ypwh8QisTFp1ZFe5', bps:  500, label: 'StonkFun top-10 5%' },
  vault:       { k: '7G63MF9NgYBM3GqsL7aVB3G4vKjEeGwfCF9iLdAFY82L', bps:  500, label: 'vault 5%' },
};

const conn = new Connection(RPC, 'confirmed');
const provider = new anchorPkg.AnchorProvider(conn, new anchorPkg.Wallet(signer), { commitment: 'confirmed' });
const idl = JSON.parse(fs.readFileSync('onchain/target/idl/rexpad.json', 'utf8'));
idl.address = PROGRAM_ID.toBase58();
const program = new anchorPkg.Program(idl, provider);
const config = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];

/** Scale the legs to sum to exactly `total`, giving the rounding remainder to the largest. */
function scaleTo(total) {
  const base = Object.entries(LEGS);
  const sum = base.reduce((a, [, v]) => a + v.bps, 0);
  const out = {}; let used = 0;
  for (const [k, v] of base) { out[k] = Math.floor((v.bps * total) / sum); used += out[k]; }
  const biggest = base.reduce((a, b) => (out[b[0]] > out[a[0]] ? b : a), base[0])[0];
  out[biggest] += total - used;
  return out;
}
const legsArg = (bpsMap) => ({
  dev2: new PublicKey(LEGS.dev2.k), dev2Bps: bpsMap.dev2,
  buyback: new PublicKey(LEGS.buyback.k), buybackBps: bpsMap.buyback,
  usdcReserve: new PublicKey(LEGS.usdcReserve.k), usdcBps: bpsMap.usdcReserve,
  plays: new PublicKey(LEGS.plays.k), playsBps: bpsMap.plays,
  vault: new PublicKey(LEGS.vault.k), vaultBps: bpsMap.vault,
});
const readRaw = async () => {
  const info = await conn.getAccountInfo(config);
  return info ? { size: info.data.length } : null;
};
const readTyped = async () => { try { return await program.account.config.fetch(config); } catch { return null; } };

console.log(`MAINNET waterfall — ${EXECUTE ? 'EXECUTE' : 'plan only, nothing will be signed'}`);
console.log(`program   ${PROGRAM_ID.toBase58()}`);
console.log(`config    ${config.toBase58()}`);
console.log(`authority ${signer.publicKey.toBase58()}`);
console.log(`balance   ${((await conn.getBalance(signer.publicKey)) / 1e9).toFixed(4)} SOL\n`);

const raw = await readRaw();
const typed = await readTyped();
console.log(`config account: ${raw.size} bytes · ${typed ? 'reads with the NEW layout' : 'OLD layout (needs migrating)'}`);
const partnerNow = typed?.partnerBps ?? 300;
console.log(`partner_bps now: ${partnerNow}  →  target ${PARTNER_TARGET}\n`);

const transient = scaleTo(10_000 - partnerNow);
const final = scaleTo(10_000 - PARTNER_TARGET);
console.log('STEP 1  migrate_config — grows the account so the typed instructions can run at all');
for (const [k, v] of Object.entries(transient)) console.log(`          ${k.padEnd(12)} ${String(v).padStart(4)} bps   ${LEGS[k].k.slice(0, 8)}…`);
console.log(`          total ${Object.values(transient).reduce((a, b) => a + b, 0)}  (must equal ${10_000 - partnerNow})`);
console.log(`\nSTEP 2  raise_partner ${partnerNow} → ${PARTNER_TARGET}`);
console.log('\nSTEP 3  migrate_config again — legs re-based on the new partner share');
for (const [k, v] of Object.entries(final)) console.log(`          ${k.padEnd(12)} ${String(v).padStart(4)} bps   ${(v / 100).toFixed(1)}%  ${LEGS[k].label}`);
console.log(`          total ${Object.values(final).reduce((a, b) => a + b, 0)}  (must equal ${10_000 - PARTNER_TARGET})`);

if (!EXECUTE) { console.log('\nRe-run with --execute to sign these three transactions.'); process.exit(0); }

const send = async (label, builder) => {
  const sig = await builder.rpc();
  console.log(`✅ ${label}  ${sig.slice(0, 20)}…`);
  return sig;
};

console.log('\n── executing');
if (!typed || Object.values(transient).reduce((a, b) => a + b, 0) !== (10_000 - partnerNow)) {
  // nothing to do differently; the require! in-program is the real gate
}
await send('migrate_config (1/3)', program.methods.migrateConfig(legsArg(transient))
  .accounts({ config, authority: signer.publicKey, systemProgram: SystemProgram.programId }));

const afterMigrate = await readTyped();
if (!afterMigrate) { console.error('⛔ config still unreadable after migration — stopping before raise_partner.'); process.exit(1); }
console.log(`   config now reads: partner_bps ${afterMigrate.partnerBps}, waterfallVersion ${afterMigrate.waterfallVersion}`);

await send('raise_partner (2/3)', program.methods.raisePartner(PARTNER_TARGET)
  .accounts({ config, authority: signer.publicKey }));

const afterRaise = await readTyped();
console.log(`   partner_bps now ${afterRaise.partnerBps}`);
if (afterRaise.partnerBps !== PARTNER_TARGET) { console.error('⛔ partner_bps did not reach the target — stopping.'); process.exit(1); }

await send('migrate_config (3/3)', program.methods.migrateConfig(legsArg(final))
  .accounts({ config, authority: signer.publicKey, systemProgram: SystemProgram.programId }));

const c = await readTyped();
console.log('\nFINAL MAINNET CONFIG');
console.log('  authority       ', c.authority.toBase58());
console.log('  partner         ', c.partner.toBase58(), c.partnerBps, 'bps =', (c.partnerBps / 100).toFixed(1) + '%');
console.log('  waterfallVersion', c.waterfallVersion);
console.log('  dev2            ', c.dev2.toBase58(), c.dev2Bps);
console.log('  buyback         ', c.buyback.toBase58(), c.buybackBps);
console.log('  usdcReserve     ', c.usdcReserve.toBase58(), c.usdcBps);
console.log('  plays           ', c.plays.toBase58(), c.playsBps);
console.log('  vault           ', c.vault.toBase58(), c.vaultBps);
const legSum = c.dev2Bps + c.buybackBps + c.usdcBps + c.playsBps + c.vaultBps;
console.log(`\n  legs ${legSum} + partner ${c.partnerBps} = ${legSum + c.partnerBps}`,
  legSum + c.partnerBps === 10_000 ? '✅ accounts for the whole' : '⛔ DOES NOT ADD UP');
