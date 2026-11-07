// Genesis for the DEVNET program, and the waterfall that the original devnet config could never
// receive.
//
// Why this exists: the first devnet config was initialised under an authority key that is no longer
// held by anyone, which left `migrate_config`, `distribute` and `raise_partner` permanently
// uncallable on that cluster. The program id is per-cluster (see declare_id in lib.rs), so devnet
// gets a fresh id and a fresh config under a live authority, and mainnet is untouched.
//
// partner_bps is set to Elio's actual number — 1000 = 10% of ALL protocol income — at genesis
// rather than written low and raised afterwards, because genesis is the one moment it can be set
// without needing raise_partner at all.
//
//   node tools/devnet_genesis.mjs            # show the plan, sign nothing
//   node tools/devnet_genesis.mjs --execute
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import fs from 'node:fs';

const EXECUTE = process.argv.includes('--execute');
const RPC = 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('975nsaKdkJYg1Ui5qHWZXDJKKRnYZ5LntNzCBT9nqov5');

const signer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));

// Elio's split of 100% of protocol income. Cyrus's 10% is the partner share and is enforced by the
// program; the remaining 9000 bps are the five waterfall legs and MUST sum to exactly that, which
// migrate_config checks rather than trusts.
const PARTNER      = new PublicKey('EGB6v3y5oS7Whv4KHYp8ksL2wRfqdfAF5Dbqq8kHXsZH'); // Cyrus — 10%
const PARTNER_BPS  = 1000;
const FEE_WALLET   = new PublicKey('6m4GQR71nWcJVrGiwcfkz5eVBQQiDHRSkzTENjavTND6'); // Elio team

// THE FIVE WALLETS, as Elio listed them one per bucket. All verified on chain before being written
// here: every one is a valid on-curve address that can actually sign, none is a PDA, none is a token
// mint, and no two are the same. That check is not ceremony — Elio previously sent a token MINT as a
// wallet, which is on-curve and looks perfectly valid, and routing a leg there would have made that
// share permanently unreachable.
const LEGS = {
  dev2:         { k: new PublicKey('6m4GQR71nWcJVrGiwcfkz5eVBQQiDHRSkzTENjavTND6'), bps: 2000, note: 'ELIO team 20%' },
  buyback:      { k: new PublicKey('5iRLrdf3CcuBfHuoDPzVtVzFgvom3qHZ2QswjBwdzcY2'), bps: 5500, note: 'buyback + burn 55%' },
  usdc_reserve: { k: new PublicKey('7vXNm42xuYL7AWSuKvLoTxymNyNTBCcGcYeJTT94yoZ2'), bps:  500, note: 'USDC reserve 5%' },
  plays:        { k: new PublicKey('AaWdfUJgZWx8E1225PNKq6FfsC95Ypwh8QisTFp1ZFe5'), bps:  500, note: 'StonkFun top-10 5%' },
  vault:        { k: new PublicKey('7G63MF9NgYBM3GqsL7aVB3G4vKjEeGwfCF9iLdAFY82L'), bps:  500, note: 'vault 5%' },
};

const sum = Object.values(LEGS).reduce((a, l) => a + l.bps, 0);
console.log(`DEVNET GENESIS — ${EXECUTE ? 'EXECUTE' : 'plan only, nothing signed'}`);
console.log(`program   ${PROGRAM_ID.toBase58()}`);
console.log(`authority ${signer.publicKey.toBase58()}`);
console.log(`partner   ${PARTNER.toBase58()}  ${PARTNER_BPS} bps = ${(PARTNER_BPS / 100).toFixed(1)}%  (Cyrus)`);
console.log(`feeWallet ${FEE_WALLET.toBase58()}\n`);
console.log('WATERFALL LEGS');
for (const [name, l] of Object.entries(LEGS))
  console.log(`  ${name.padEnd(13)} ${String(l.bps).padStart(4)} bps  ${(l.bps / 100).toFixed(1).padStart(5)}%  ${l.k.toBase58().slice(0, 8)}…  ${l.note}`);
console.log(`  ${'TOTAL'.padEnd(13)} ${String(sum).padStart(4)} bps  must equal ${10_000 - PARTNER_BPS}`);
if (sum !== 10_000 - PARTNER_BPS) { console.error('\n⛔ legs do not close against the partner share — migrate_config would reject this.'); process.exit(1); }
console.log('  ✅ closes exactly\n');
if (!EXECUTE) { console.log('Re-run with --execute to sign.'); process.exit(0); }

const conn = new Connection(RPC, 'confirmed');
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(signer), { commitment: 'confirmed' });
const idl = JSON.parse(fs.readFileSync('onchain/target/idl/rexpad.json', 'utf8'));
idl.address = PROGRAM_ID.toBase58();
const program = new anchor.Program(idl, provider);
const config = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];
console.log('config PDA', config.toBase58());

const existing = await conn.getAccountInfo(config);
if (!existing) {
  const sig = await program.methods.initConfig(100, 25, PARTNER, PARTNER_BPS)
    .accounts({ config, authority: signer.publicKey, feeWallet: FEE_WALLET, systemProgram: SystemProgram.programId })
    .rpc();
  console.log('✅ init_config', sig);
} else {
  console.log('config already exists — skipping init_config');
}

const legs = {
  dev2: LEGS.dev2.k, dev2Bps: LEGS.dev2.bps,
  buyback: LEGS.buyback.k, buybackBps: LEGS.buyback.bps,
  usdcReserve: LEGS.usdc_reserve.k, usdcBps: LEGS.usdc_reserve.bps,
  plays: LEGS.plays.k, playsBps: LEGS.plays.bps,
  vault: LEGS.vault.k, vaultBps: LEGS.vault.bps,
};
const sig2 = await program.methods.migrateConfig(legs)
  .accounts({ config, authority: signer.publicKey, systemProgram: SystemProgram.programId })
  .rpc();
console.log('✅ migrate_config', sig2);

const c = await program.account.config.fetch(config);
console.log('\nON-CHAIN CONFIG NOW');
console.log('  authority        ', c.authority.toBase58());
console.log('  partner          ', c.partner.toBase58(), c.partnerBps, 'bps');
console.log('  waterfallVersion ', c.waterfallVersion);
console.log('  dev2             ', c.dev2.toBase58(), c.dev2Bps);
console.log('  buyback          ', c.buyback.toBase58(), c.buybackBps);
console.log('  usdcReserve      ', c.usdcReserve.toBase58(), c.usdcBps);
console.log('  plays            ', c.plays.toBase58(), c.playsBps);
console.log('  vault            ', c.vault.toBase58(), c.vaultBps);
