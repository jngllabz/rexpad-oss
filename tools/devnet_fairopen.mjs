// The Fair Open lifecycle, end to end, on real devnet — the test that answers "why is Fair Open
// fills 0".
//
// It launches with a short window, commits from two wallets at DIFFERENT sizes, settles, and then
// asks the indexer whether the fills were recorded. Two different sizes is the point: a single
// bidder would pass even if the pro-rata split were wrong, and the split is the whole mechanic.
//
//   RPC_URL=https://api.devnet.solana.com node tools/devnet_fairopen.mjs
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import fs from 'node:fs';
import os from 'node:os';

process.env.RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const CH = await import('../lib/chain.mjs');
const IX = await import('../lib/indexer.mjs');
const { db } = await import('../lib/db.mjs');

const conn = new Connection(process.env.RPC_URL, 'confirmed');
const WSOL = 'So11111111111111111111111111111111111111112';
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf8'))));
const WINDOW = Number(process.env.WINDOW || 45);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const send = async (tx, signers) => {
  if (!tx.recentBlockhash) {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  }
  // partialSign, not sign: a packed transaction already carries signatures (the launch mint signs
  // its own creation), and sign() would discard them.
  for (const s of signers) tx.partialSign(s);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
};
/** A builder's base64 transaction, signed by `kp` and sent. */
const sendBuilt = async (b, kp) => send(Transaction.from(Buffer.from(b.tx, 'base64')), [kp]);

console.log(`payer ${payer.publicKey.toBase58()}  ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);

// Two bidders, funded from the payer. Different amounts, so the pro-rata split is actually tested.
const a = Keypair.generate(), b = Keypair.generate();
const BID_A = 0.02 * LAMPORTS_PER_SOL, BID_B = 0.06 * LAMPORTS_PER_SOL;   // a 1:3 split
console.log('\n1. funding two bidders');
await send(new Transaction().add(
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: a.publicKey, lamports: BID_A + 0.03 * LAMPORTS_PER_SOL }),
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: b.publicKey, lamports: BID_B + 0.03 * LAMPORTS_PER_SOL }),
), [payer]);
console.log(`   A ${a.publicKey.toBase58().slice(0, 8)} bids ${BID_A / LAMPORTS_PER_SOL}  ·  B ${b.publicKey.toBase58().slice(0, 8)} bids ${BID_B / LAMPORTS_PER_SOL}`);

console.log(`\n2. launch with a ${WINDOW}s Fair Open window`);
const raiseTarget = Math.floor(2 * LAMPORTS_PER_SOL);
const built = await CH.buildCreateLaunch({
  creator: payer.publicKey.toBase58(), quoteMint: WSOL, raiseTarget,
  vQuote0: Math.floor(raiseTarget * 30 / 85), holderBps: 300, creatorBps: 100, fairOpenSecs: WINDOW,
});
const mint = built.mint;
await sendBuilt(built, payer);
IX.saveMeta({ mint, name: 'Fair Open Test', symbol: 'FOTEST', creator: payer.publicKey.toBase58() });
await IX.reconcile();
console.log('   mint', mint);

console.log('\n3. both bidders commit');
for (const [kp, amt, who] of [[a, BID_A, 'A'], [b, BID_B, 'B']]) {
  const sig = await sendBuilt(await CH.buildCommit({ bidder: kp.publicKey.toBase58(), mint, amount: amt }), kp);
  console.log(`   ${who} committed ${amt / LAMPORTS_PER_SOL} SOL  ${sig.slice(0, 10)}…`);
}

await IX.reconcile();
const l0 = (await CH.launches()).find((x) => x.mint === mint);
console.log(`   fair_open_total on chain: ${(l0?.fairOpenTotal ?? 0) / LAMPORTS_PER_SOL} SOL`);

console.log(`\n4. waiting out the window (${WINDOW}s)`);
await new Promise((r) => setTimeout(r, (WINDOW + 6) * 1000));

console.log('\n5. settle');
const settleSig = await CH.settleFairOpen(mint, payer);
console.log('   ', settleSig);
await new Promise((r) => setTimeout(r, 4000));

console.log('\n6. does the indexer record the fills?');
await IX.reconcile();
await IX.backfill();
const rows = db.prepare("SELECT wallet, quote, tokens, price, sig, ev_ix FROM trades WHERE mint=? AND kind='fairopen' ORDER BY ev_ix").all(mint);
console.table(rows.map((r) => ({ bidder: r.wallet.slice(0, 8), quote: r.quote, tokens: Math.round(r.tokens), price: r.price, ev_ix: r.ev_ix })));

ok(rows.length === 2, `F1 both fills recorded (got ${rows.length})`);
// Counted globally, because the backfill also recovers fills from every EARLIER settlement it walks
// — which is the point: the figure was never zero on chain, only in our database.
const total = db.prepare("SELECT COUNT(*) n FROM trades WHERE kind='fairopen'").get().n;
ok(total >= rows.length && total > 0, `F2 the Fair Open fills counter moves off zero (${total} fills)`);
if (rows.length === 2) {
  const byWallet = Object.fromEntries(rows.map((r) => [r.wallet, r]));
  const ra = byWallet[a.publicKey.toBase58()], rb = byWallet[b.publicKey.toBase58()];
  ok(!!ra && !!rb, 'F3 one fill per bidder, attributed to the right wallet');
  if (ra && rb) {
    // The mechanic itself: a 1:3 commitment must produce a 1:3 allocation...
    const ratio = rb.tokens / ra.tokens;
    ok(Math.abs(ratio - 3) < 0.02, `F4 allocation is pro-rata to the commitment (B/A = ${ratio.toFixed(4)}, want 3)`);
    // ...at ONE price, which is what "uniform price" means and what makes it fair.
    ok(Math.abs(ra.price - rb.price) / Math.max(ra.price, rb.price) < 1e-6,
      `F5 both cleared at the SAME price (${ra.price} vs ${rb.price})`);
  }
}
// Re-running must not double anything: the backfill will walk this settlement again.
await IX.backfill();
ok(db.prepare("SELECT COUNT(*) n FROM trades WHERE mint=? AND kind='fairopen'").get(mint).n === rows.length,
  'F6 a second pass over the same settlement records nothing twice');

const DS = await import('../lib/dexscreener.mjs');
const evs = DS.events(0, 9e9).events.filter((e) => e.pairId === mint);
ok(evs.length >= rows.length, `F7 the fills reach the DexScreener feed too (${evs.length} events on this pair)`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log('explorer https://solscan.io/tx/' + settleSig + '?cluster=devnet');
process.exit(fail ? 1 : 0);
