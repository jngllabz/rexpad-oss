// Point the waterfall's BUYBACK leg at the wallet that can actually burn.
//
//   node tools/buyback_to_burn.mjs              # plan only, signs nothing
//   node tools/buyback_to_burn.mjs --execute
//
// ⛔ WHY. The burn pot shown on the site is nothing more than the rewards payer wallet's own
// balance (`refreshPot()` in ~/rex-rewards/server.mjs), and a burn is
// `createBurnCheckedInstruction(myAta, mint, payer.publicKey, …)` — it can only destroy REX that
// THAT wallet holds. Nothing has reached it since 2026-09-23: twelve days with no transactions at
// all, while $REX itself earns nothing post-graduation (LP burned, no fee-claim instruction).
//
// Meanwhile REX Chain's own waterfall has a leg whose stated purpose is "buyback + burn 55%", and
// the first protocol distribution put 1,151,623.82 REX into it — in a wallet that cannot burn.
// Two mechanisms for one job, with the money in the one that has no hands.
//
// This repoints that leg's DESTINATION at the rewards payer. Shares are untouched: the leg keeps
// 5500 bps, every other leg keeps its own, and the sum is re-checked against the on-chain
// partner_bps before anything is signed.
//
// ⛔ IT DOES NOT MOVE THE 1,151,623.82 REX ALREADY SITTING THERE. Only whoever holds that wallet's
// key can send it, and this tool never asks for one. This fixes the pipe, not the puddle.
//
// ⛔ EVERY LEG IS READ FROM THE CHAIN, never from a table in this file. A hardcoded list is a list
// that silently reverts whatever anybody changed since it was written — on a config that decides
// where money goes.
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import fs from 'node:fs';

const EXECUTE = process.argv.includes('--execute');
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID = new PublicKey('2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E');
// The rewards payer — the only wallet whose REX the burn instruction can destroy.
const BURNER = new PublicKey('2DaEMgd9RBT2p8vKJoswkjbrawdZEDAC93dhg2ShDwvw');
const REX = new PublicKey('CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump');

const keyPath = `${process.env.HOME}/.config/solana/id.json`;
if (!fs.existsSync(keyPath)) { console.error(`⛔ no key at ${keyPath} — this must run where the config authority's key is.`); process.exit(1); }
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));

const conn = new Connection(RPC, 'confirmed');
const provider = new anchorPkg.AnchorProvider(conn, new anchorPkg.Wallet(signer), { commitment: 'confirmed' });
const idl = JSON.parse(fs.readFileSync('onchain/target/idl/rexpad.json', 'utf8'));
idl.address = PROGRAM_ID.toBase58();
const program = new anchorPkg.Program(idl, provider);
const config = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];

const c = await program.account.config.fetch(config).catch(() => null);
if (!c) { console.error('⛔ config unreadable — refusing to guess at a money route.'); process.exit(1); }

const b58 = (v) => (v?.toBase58 ? v.toBase58() : String(v));
const legs = [
  ['dev2', 'dev2Bps', 'Dev'], ['buyback', 'buybackBps', 'Buyback + burn'],
  ['usdcReserve', 'usdcBps', 'USDC reserve'], ['plays', 'playsBps', 'Plays'], ['vault', 'vaultBps', 'Vault'],
].map(([w, bps, label]) => ({ key: w, label, wallet: b58(c[w]), bps: Number(c[bps]) || 0 }));

console.log(`\nBUYBACK LEG → BURNER  ${EXECUTE ? '(EXECUTE)' : '(plan only, nothing will be signed)'}`);
console.log(`authority   ${signer.publicKey.toBase58()}   ${c.authority ? '(config says ' + b58(c.authority) + ')' : ''}`);
if (c.authority && b58(c.authority) !== signer.publicKey.toBase58()) {
  console.error('⛔ this key is NOT the config authority — the program would refuse it. Stopping.');
  process.exit(1);
}

const total = legs.reduce((a, l) => a + l.bps, 0);
const want = 10_000 - Number(c.partnerBps || 0);
console.log(`\nlegs on chain now (partner ${c.partnerBps} bps, so these must sum to ${want}):`);
for (const l of legs) console.log(`  ${l.label.padEnd(15)} ${String(l.bps).padStart(5)} bps  ${l.wallet}`);
console.log(`  ${'sum'.padEnd(15)} ${String(total).padStart(5)} bps  ${total === want ? '✅' : '⛔ does not match — stopping'}`);
if (total !== want) process.exit(1);

const bb = legs.find((l) => l.key === 'buyback');
if (bb.wallet === BURNER.toBase58()) { console.log('\nAlready pointed at the burner — nothing to do.'); process.exit(0); }

const held = async (owner) => {
  const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: REX }).catch(() => null);
  return r?.value?.[0] ? Number(r.value[0].account.data.parsed.info.tokenAmount.uiAmount) : 0;
};
console.log(`\nchange:  buyback destination`);
console.log(`  from   ${bb.wallet}   holds ${(await held(bb.wallet)).toLocaleString('en-US')} REX  ← cannot burn; only its key holder can move this`);
console.log(`  to     ${BURNER.toBase58()}   holds ${(await held(BURNER)).toLocaleString('en-US')} REX  ← the wallet the burn signs as`);
console.log(`  shares unchanged: buyback stays ${bb.bps} bps, every other leg keeps its own.`);

if (!EXECUTE) { console.log('\n(plan only — re-run with --execute to sign it)'); process.exit(0); }

const arg = {
  dev2: new PublicKey(legs[0].wallet), dev2Bps: legs[0].bps,
  buyback: BURNER, buybackBps: bb.bps,
  usdcReserve: new PublicKey(legs[2].wallet), usdcBps: legs[2].bps,
  plays: new PublicKey(legs[3].wallet), playsBps: legs[3].bps,
  vault: new PublicKey(legs[4].wallet), vaultBps: legs[4].bps,
};
const sig = await program.methods.migrateConfig(arg)
  .accounts({ config, authority: signer.publicKey, systemProgram: SystemProgram.programId }).rpc();
console.log(`\n✅ migrate_config ${sig}`);

const after = await program.account.config.fetch(config);
console.log(`buyback now → ${b58(after.buyback)} at ${after.buybackBps} bps`);
console.log(b58(after.buyback) === BURNER.toBase58() ? '✅ verified on chain' : '⛔ chain does not agree — check before relying on it');
