// Who holds what. Prints every key REX Chain needs, what it can do, and what is actually configured
// on the cluster you point it at — so the gap between "what we need" and "what exists" is visible.
//
//   RPC_URL=https://api.devnet.solana.com node tools/wallets.mjs
//   node tools/wallets.mjs --new <role>     # generate a keypair for one role, printed once
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import bs58 from 'bs58';

const ROLES = [
  {
    key: 'authority',
    name: 'Config authority',
    who: 'REX Chain / the company — ideally a multisig, not one person',
    can: 'Post reward epochs · sweep the vault, burn and REX buckets · lower REX tiers · pause the program',
    risk: 'Total. It is the protocol. It can now be handed over (propose → accept), but losing it with no handover in flight ends the protocol: no epoch can ever be posted again.',
    hot: false,
  },
  {
    key: 'crank',
    name: 'Crank (server hot key)',
    who: 'The REX Chain server — lives in CRANK_KEY on the host',
    can: 'Ring Fair Open bells (permissionless, any key may) · post epochs ONLY if it is also the authority',
    risk: 'Low if it is only a cranker. High today, because it is currently the authority too.',
    hot: true,
  },
  {
    key: 'partner',
    name: 'Revenue share (your 10%)',
    who: 'You — separate from every key Elio needs',
    can: 'Receives its share of REX Chain\'s cut, split off at the moment each fee is earned. Withdraw per launch with claim_partner, signed by this key alone.',
    risk: 'Set ONCE and permanent: no instruction in the program can lower it, zero it, or point it elsewhere — not the authority, not a new authority, not you. Only this key can rotate which wallet receives it. The single remaining way to undo it is a PROGRAM UPGRADE, so see the upgrade authority below.',
    hot: false,
  },
  {
    key: 'rex',
    name: 'REX revenue',
    who: 'Elio / the company treasury',
    can: 'Receives sweep_bucket(4) — REX Chain\'s cut, already net of the revenue share above',
    risk: 'Holds revenue. It only ever receives; nothing is signed with it.',
    hot: false,
  },
  {
    key: 'vault',
    name: 'Vault operations',
    who: 'Whoever runs the 70/30 LP position',
    can: 'Receives sweep_bucket(2) — the vault leg, to be deployed as 70% concentrated LP / 30% quote bid',
    risk: 'Holds other people\'s liquidity. The spec says this address is public from the first deposit and cannot be redeemed.',
    hot: false,
  },
  {
    key: 'burn',
    name: 'Burn executor',
    who: 'Can be the same as vault ops, or a bot',
    can: 'Receives sweep_bucket(3) — quote to buy the launched token on the open market and destroy it',
    risk: 'Transits funds only. Everything it receives should leave as a buy-and-burn.',
    hot: true,
  },
];

const arg = process.argv.indexOf('--new');
if (arg > -1) {
  const role = process.argv[arg + 1];
  const r = ROLES.find((x) => x.key === role);
  if (!r) { console.error(`unknown role "${role}" — one of: ${ROLES.map((x) => x.key).join(', ')}`); process.exit(1); }
  const kp = Keypair.generate();
  console.log(`\n${r.name}\n  pubkey  ${kp.publicKey.toBase58()}`);
  console.log(`  secret  ${bs58.encode(kp.secretKey)}`);
  console.log(`\n  ⚠ This is printed once and not saved anywhere. Put the secret in a password manager`);
  console.log(`    or a hardware wallet now. ${r.hot ? 'This one is a hot key: it lives on a server, so fund it with\n    only what it needs for transaction fees.' : 'This one should NEVER touch a server — it is a cold key.'}\n`);
  process.exit(0);
}

console.log('\nREX Chain — keys and who should hold them\n' + '─'.repeat(78));
for (const r of ROLES) {
  console.log(`\n${r.name}  ${r.hot ? '[hot — on a server]' : '[cold — offline]'}`);
  console.log(`  who   ${r.who}`);
  console.log(`  can   ${r.can}`);
  console.log(`  risk  ${r.risk}`);
}

const RPC = process.env.RPC_URL;
if (!RPC) {
  console.log('\n' + '─'.repeat(78));
  console.log('Set RPC_URL to also report what is configured on a cluster.');
  console.log('Generate one with:  node tools/wallets.mjs --new <authority|crank|rex|vault|burn>\n');
  process.exit(0);
}

console.log('\n' + '─'.repeat(78) + `\nOn-chain state at ${RPC}\n`);
process.env.RPC_URL = RPC;
// Swap income is configured off chain, so it does not show up in the program's config — print it
// here or the fact that the 0.5% is silently collecting nothing has nowhere to surface.
{
  const { cfg } = await import('../lib/config.mjs');
  const JUP = await import('../lib/jupiter.mjs');
  console.log('\nJupiter swaps');
  console.log(`  fee wallet         ${cfg.jupFeeWallet || '— NOT SET (no fee taken)'}`);
  console.log(`  configured fee     ${(JUP.feeBps() / 100).toFixed(2)}%`);
  if (cfg.jupFeeWallet) {
    const CORE = { SOL: 'So11111111111111111111111111111111111111112', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', REX: cfg.rexCa };
    const open = [];
    for (const [sym, mint] of Object.entries(CORE)) if (await JUP.feeAccountFor(mint)) open.push(sym);
    console.log(`  collecting on      ${open.length ? open.join(', ') : '— nothing yet'}`);
    if (!open.length) console.log('  ⚠ no fee accounts exist, so every swap routes fee-free. Run tools/jup-fee-accounts.mjs.');
  }
}

const CH = await import('../lib/chain.mjs');
try {
  const c = await CH.configAccount();
  if (!c) { console.log('  no config account yet — the program has never been initialised on this cluster\n'); process.exit(0); }
  const crank = CH.crankKeypair();
  console.log(`  program            ${CH.programId().toBase58()}`);
  console.log(`  authority          ${c.authority}`);
  console.log(`  pending authority  ${c.pendingAuthority === PublicKey.default.toBase58() ? '— none in flight' : c.pendingAuthority}`);
  console.log(`  server crank key   ${crank ? crank.publicKey.toBase58() : '— not configured (CRANK_KEY unset)'}`);
  console.log(`  paused             ${c.paused}`);
  const shareSet = c.partnerBps > 0;
  console.log(`  revenue share      ${shareSet ? `${(c.partnerBps / 100).toFixed(1)}% of REX Chain's cut → ${c.partner}` : '— NOT SET'}`);
  if (!shareSet) {
    console.log(`\n  ⚠ No revenue share is configured, and it can only be set ONCE. Whoever calls`);
    console.log(`    set_partner first decides it permanently, so set it before anyone else does:`);
    console.log(`      node tools/set-share.mjs <YOUR_WALLET> 300       # 300 bps = 10% of Development`);
  }
  if (crank && c.authority === crank.publicKey.toBase58()) {
    console.log(`\n  ⚠ The server's hot key IS the config authority. Anyone who reaches the host can`);
    console.log(`    sweep every bucket on every launch. Hand the authority to a cold key or multisig:`);
    console.log(`      node -e 'import("./lib/chain.mjs").then(c => c.proposeAuthority("<COLD_PUBKEY>"))'`);
    console.log(`    then accept it from that key. The crank keeps working — ringing the bell is`);
    console.log(`    permissionless — but posting epochs then needs the authority to sign.`);
  }
  // The one thing the program cannot protect against is being replaced wholesale.
  const conn = new Connection(RPC, 'confirmed');
  const pd = PublicKey.findProgramAddressSync([CH.programId().toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  const info = await conn.getAccountInfo(pd);
  if (info && info.data.length > 45) {
    const immutable = info.data[12] === 0;
    const upgrader = immutable ? null : new PublicKey(info.data.subarray(13, 45)).toBase58();
    console.log(`\n  upgrade authority  ${immutable ? 'none — the program is IMMUTABLE' : upgrader}`);
    if (!immutable) {
      console.log(`\n  ⚠ Whoever holds that key can replace this program outright, and with it every`);
      console.log(`    guarantee above — the permanent revenue share included. It is the only way left`);
      console.log(`    to revoke the share, so it must not be one person's key:`);
      console.log(`      · put it on a multisig that needs BOTH parties (Squads 2-of-2), or`);
      console.log(`      · after the audit, burn it:  solana program set-upgrade-authority <ID> --final`);
    }
  }
  if (crank) {
    const bal = await conn.getBalance(crank.publicKey);
    console.log(`\n  crank SOL balance  ${(bal / 1e9).toFixed(4)}${bal < 0.05e9 ? '   ⚠ too low to keep cranking' : ''}`);
  }
} catch (e) {
  console.log(`  could not read the config: ${e.message}`);
}
console.log('');
