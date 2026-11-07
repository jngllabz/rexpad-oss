// Can a META / ALTS / Stocks pair actually be used on devnet, end to end?
//
// "Launchable" was never the bar. The tabs were greyed out because those mints do not exist on
// devnet, and minting stand-ins only fixes half of it: a tester who can create a STONK-quoted coin
// but cannot obtain a single STONK still has a dead tab. So this funds, launches AND buys.
//
// The three assets are chosen for their DECIMALS, not their names: 6, 8 and 12. The faucet used to
// scale every amount by 1e6, which would hand out a hundredth of an xStock and a millionth of a
// Monero, and the curve would price the resulting pairs accordingly.
//
//   RPC_URL=https://api.devnet.solana.com node tools/devnet_meta.mjs
import { Keypair, Connection, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import fs from 'node:fs';
import os from 'node:os';

process.env.RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
process.env.FAUCET_MINT = process.env.FAUCET_MINT || JSON.parse(fs.readFileSync('devnet-mints.json', 'utf8')).REX;

const CH = await import('../lib/chain.mjs');
const { QUOTES } = await import('../lib/prices.mjs');
const { cfg } = await import('../lib/config.mjs');
const { getAccount, getAssociatedTokenAddressSync } = await import('@solana/spl-token');

const conn = new Connection(process.env.RPC_URL, 'confirmed');
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf8'))));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const sendBuilt = async (b, kp) => {
  const tx = Transaction.from(Buffer.from(b.tx, 'base64'));
  tx.partialSign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
};

// 6, 8 and 12 decimals — one from each tab, picked to catch a scaling bug.
const CASES = ['STONK', 'NVDAx', 'XMR'];
const w = Keypair.generate();
console.log(`tester ${w.publicKey.toBase58()}\nauthority ${authority.publicKey.toBase58()}  ${(await conn.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL} SOL\n`);

for (const sym of CASES) {
  const q = QUOTES[sym];
  console.log(`— ${sym} (${q.decimals} dp)`);
  try {
    const r = await CH.faucet(w.publicKey.toBase58(), authority, sym);
    const bal = await getAccount(conn, getAssociatedTokenAddressSync(new (await import('@solana/web3.js')).PublicKey(q.mint), w.publicKey));
    const ui = Number(bal.amount) / 10 ** q.decimals;
    ok(Math.abs(ui - cfg.faucetAmount) < 1e-6,
      `  faucet sent ${ui} ${sym} — the full ${cfg.faucetAmount}, scaled by ITS decimals not by 1e6`);
  } catch (e) { ok(false, `  faucet ${sym}: ${e.message}`); }
}

// An asset we hold no mint authority over must fail honestly rather than half-succeed on chain.
try { await CH.faucet(w.publicKey.toBase58(), authority, 'SOL'); ok(false, 'SOL refused'); }
catch (e) { ok(/lamports|not minted/i.test(e.message), `SOL is refused with a real reason: ${e.message}`); }
try { await CH.faucet(w.publicKey.toBase58(), authority, 'NOPE'); ok(false, 'unknown asset refused'); }
catch (e) { ok(/unknown asset/i.test(e.message), `an unknown ticker is refused: ${e.message}`); }

// The whole point: launch against a META quote and buy it with the funded balance.
console.log('\n— launch + buy a STONK-quoted coin');
const q = QUOTES.STONK;
const raise = Math.floor(50_000 * 10 ** q.decimals);
const built = await CH.buildCreateLaunch({
  creator: w.publicKey.toBase58(), quoteMint: q.mint, raiseTarget: raise,
  vQuote0: Math.floor(raise * 30 / 85), holderBps: 300, creatorBps: 100, fairOpenSecs: 0,
});
await sendBuilt(built, w);
console.log('  mint', built.mint);
const buy = await CH.buildBuy({ user: w.publicKey.toBase58(), mint: built.mint, quoteIn: Math.floor(1000 * 10 ** q.decimals) });
const buySig = await sendBuilt(buy, w);
console.log('  bought', buySig.slice(0, 12) + '…');

const l = (await CH.launches()).find((x) => x.mint === built.mint);
ok(!!l, '  the launch exists on chain');
ok(String(l?.quoteMint) === q.mint, '  and is quoted in the STONK stand-in');
ok((l?.realQuote ?? 0) > 0 && (l?.realToken ?? 0) > 0, `  the buy landed on the curve (realQuote ${l?.realQuote})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
