// Set the revenue share on REX Chain's own cut. This is a ONE-WAY, ONE-TIME action: the program has
// no instruction that can lower it, zero it, or redirect it afterwards.
//
// `bps` is a share of the REX bucket, not of the trade. 300 bps = 3% of protocol income, which is
// a tenth of the Development leg of REX's 60/30/10 waterfall.
//
//   RPC_URL=https://api.devnet.solana.com CRANK_KEY=<authority secret> \
//     node tools/set-share.mjs <RECEIVING_WALLET> 300       # 300 bps = 10% of Development
import { PublicKey } from '@solana/web3.js';

const [wallet, bpsArg] = process.argv.slice(2);
const bps = Number(bpsArg);
if (!wallet || !Number.isInteger(bps)) {
  console.error('usage: node tools/set-share.mjs <RECEIVING_WALLET> <BPS>   (300 = 10% of Development)');
  process.exit(1);
}
let dest;
try { dest = new PublicKey(wallet); } catch { console.error(`"${wallet}" is not a valid address`); process.exit(1); }
if (bps < 1 || bps > 5000) { console.error('the share must be between 1 and 5000 bps (0.01% – 50%)'); process.exit(1); }

const CH = await import('../lib/chain.mjs');
const signer = CH.crankKeypair();
if (!signer) { console.error('set CRANK_KEY to the config authority\'s secret key'); process.exit(1); }

const cfg = await CH.configAccount();
if (!cfg) { console.error('the program has no config on this cluster yet — run initConfig first'); process.exit(1); }
if (cfg.authority !== signer.publicKey.toBase58()) {
  console.error(`CRANK_KEY is ${signer.publicKey.toBase58()} but the authority is ${cfg.authority}`);
  process.exit(1);
}
if (cfg.partnerBps > 0) {
  console.error(`\nA share is already set and it is permanent:\n  ${(cfg.partnerBps / 100).toFixed(1)}% → ${cfg.partner}\n`);
  console.error('Nothing can change it. If this is not what was agreed, the program has to be');
  console.error('redeployed from scratch before anyone trades against it.\n');
  process.exit(1);
}

console.log(`\nAbout to set, permanently and irreversibly:`);
console.log(`  ${(bps / 100).toFixed(2)}% of REX Chain's cut  →  ${dest.toBase58()}`);
console.log(`  on program ${CH.programId().toBase58()}`);
console.log(`\nAfter this, no key — including this one — can lower it, remove it, or point it at a`);
console.log(`different wallet. Only ${dest.toBase58().slice(0, 8)}… can rotate which address receives it.`);
console.log(`\nProceeding in 5s. Ctrl-C to stop.`);
await new Promise((r) => setTimeout(r, 5000));

const sig = await CH.setPartner(dest.toBase58(), bps);
const after = await CH.configAccount();
console.log(`\n✅ set: ${(after.partnerBps / 100).toFixed(2)}% → ${after.partner}`);
console.log(`   ${sig}\n`);
console.log(`Withdraw per launch with claim_partner, signed by that wallet alone — it does not need`);
console.log(`the authority, a crank, or anyone else to have swept anything first.\n`);
