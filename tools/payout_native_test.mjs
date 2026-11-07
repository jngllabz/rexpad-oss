// ⛔ A SOL PAIR'S QUOTE MINT IS **WRAPPED** SOL, AND NOBODY HOLDS WRAPPED SOL.
//
// The first real protocol distribution paid six assets and failed on the seventh — SOL, $315, the
// largest of them — with "invalid account data for instruction". The reason: the sender was the fee
// claimer's wSOL associated token account, and that account has never existed. wSOL lives for the
// seconds inside a swap; nobody keeps a standing balance of it. The fee claimer holds 3.36 NATIVE
// SOL and no token account at all.
//
// It is the same trap that read every SOL-quoted launcher's balance as zero on 5 Oct, reappearing
// on the send side a fortnight later, which is reason enough for this file to exist.
//
//   node tools/payout_native_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-pn-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'pn.sqlite';
const CLAIMER = Keypair.generate();
process.env.FEE_CLAIMER_KEY = bs58.encode(CLAIMER.secretKey);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const addr = () => Keypair.generate().publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const PO = await import('../lib/payout.mjs');

const LEGS = [
  { key: 'partner', label: 'Partner', wallet: addr(), bps: 1000 },
  { key: 'dev', label: 'Dev', wallet: addr(), bps: 2000 },
  { key: 'buyback', label: 'Buyback', wallet: addr(), bps: 5500 },
  { key: 'reserve', label: 'USDC reserve', wallet: addr(), bps: 500 },
  { key: 'plays', label: 'Plays', wallet: addr(), bps: 500 },
  { key: 'vault', label: 'Vault', wallet: addr(), bps: 500 },
];
const CH = {
  tokenProgramOf: async () => TOKEN_PROGRAM_ID,
  waterfall: async () => ({ legs: LEGS, totalBps: 10_000, authority: addr(), paused: false }),
};

const MINT = addr();
db.prepare(`INSERT INTO tokens(mint,name,symbol,quote,quote_mint,status,venue,created_at,rex_pot,rex_paid)
            VALUES(?,?,?,?,?,?,?,?,?,0)`)
  .run(MINT, 'Sol Pair', 'SOLP', 'SOL', NATIVE_MINT.toBase58(), 'live', 'dbc', Date.now(), 2.718203);

const WSOL_ATA = getAssociatedTokenAddressSync(NATIVE_MINT, CLAIMER.publicKey, true, TOKEN_PROGRAM_ID);
/** An SPL token account holding `raw` units — the amount sits at offset 64. */
const tokenAccount = (raw) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(raw), 64); return { data: b, owner: TOKEN_PROGRAM_ID }; };

/**
 * A connection whose native balance and wSOL account can be posed as they really were.
 *
 * ⛔ IT HAS TO ANSWER PER ADDRESS. The distribution is capped at what the claimer actually holds,
 * so a stub that answers the same way for every account either hides the wSOL case or starves the
 * SPL one. `wsol` poses the claimer's wSOL ATA; `splHeld` poses every other token account.
 */
const makeConn = ({ lamports = 5_000_000_000, wsol = null, splHeld = 10n ** 18n } = {}) => ({
  sent: [], txns: [],
  getLatestBlockhash: async () => ({ blockhash: bs58.encode(Keypair.generate().publicKey.toBytes()) }),
  getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } }),
  getAccountInfo: async (pk) => (String(pk) === WSOL_ATA.toBase58()
    ? (wsol == null ? null : tokenAccount(wsol))
    : (splHeld == null ? null : tokenAccount(splHeld))),
  getTokenAccountBalance: async () => ({ value: { amount: String(wsol ?? 0) } }),
  getBalance: async () => lamports,
  sendRawTransaction: async function (b) { this.sent.push(b); return 'sig'; },
  confirmTransaction: async () => ({ value: { err: null } }),
  getSignatureStatuses: async () => ({ value: [null] }),
});

// The transaction is signed inside payout.mjs, so read it back off the wire the way the chain would.
const decode = (raw) => {
  const { Transaction } = require('@solana/web3.js');
  return Transaction.from(raw);
};
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

console.log('── ⛔ A SOL PAYOUT USES THE SYSTEM PROGRAM, NOT THE TOKEN PROGRAM');
{
  const conn = makeConn();
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1 && r.failed === 0, 'the SOL leg sends (it used to fail: "invalid account data")');
  const txn = decode(conn.sent[0]);
  const progs = new Set(txn.instructions.map((i) => i.programId.toBase58()));
  ok(progs.has(SystemProgram.programId.toBase58()), 'it carries SystemProgram transfers');
  ok(!progs.has(TOKEN_PROGRAM_ID.toBase58()), 'and not one token-program instruction');
  ok(txn.instructions.length === 6, `one instruction per leg, no ATA creations (${txn.instructions.length})`);
}

console.log('\n── every lamport reaches a leg, and the legs are the waterfall');
{
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0 WHERE mint=?').run(2.718203, MINT);
  const conn = makeConn();
  await PO.payProtocol({ conn, CH, execute: true });
  const txn = decode(conn.sent[0]);
  const total = txn.instructions.reduce((a, i) => a + Number(i.data.readBigUInt64LE(4)), 0);
  ok(total === 2_718_203_000, `the transfers sum to exactly 2.718203 SOL (${total} lamports)`);
  const dests = new Set(txn.instructions.map((i) => i.keys[1].pubkey.toBase58()));
  ok(LEGS.every((l) => dests.has(l.wallet)), 'and every waterfall wallet is a destination');
}

console.log('\n── ⛔ THE FEE CLAIMER IS ALSO THE FEE PAYER AND MUST STAY RENT-EXEMPT');
{
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0 WHERE mint=?').run(2.718203, MINT);
  // Exactly the amount owed and not one lamport more: enough to transfer, nothing left for the fee.
  const conn = makeConn({ lamports: 2_718_203_000 });
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.failed === 1 && r.sent === 0, 'refused rather than draining the wallet it pays fees from');
  ok(db.prepare('SELECT rex_pot FROM tokens WHERE mint=?').get(MINT).rex_pot > 2.7, 'and the pot was not debited');
}

console.log('\n── standing wSOL is the same asset, so it is unwrapped into the same transaction');
{
  db.prepare('UPDATE tokens SET rex_pot=?, rex_paid=0 WHERE mint=?').run(2.718203, MINT);
  const conn = makeConn({ lamports: 1_000_000_000, wsol: 2_000_000_000 });
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1, 'a claimer short on native but holding wSOL can still pay');
  const txn = decode(conn.sent[0]);
  // ⛔ AND IT PAYS IN FULL. The balance cap has to count what the send path CAN SPEND, which
  // includes the wSOL this transaction unwraps — counting lamports alone capped a claimer holding
  // 3 SOL to the 1 that happened to be native and quietly short-paid the other 1.718.
  const paid = txn.instructions
    .filter((i) => i.programId.equals(SystemProgram.programId))
    .reduce((a, i) => a + Number(i.data.readBigUInt64LE(4)), 0);
  ok(paid === 2_718_203_000, `in full, wSOL counted toward the cap (${paid} lamports)`);
  const closes = txn.instructions.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID));
  ok(closes.length === 1, 'by closing the wSOL account, which unwraps it, in the same transaction');
  const want = getAssociatedTokenAddressSync(NATIVE_MINT, CLAIMER.publicKey, true, TOKEN_PROGRAM_ID);
  ok(closes[0].keys[0].pubkey.equals(want), 'and it closes the claimer\'s own wSOL ATA');
}

console.log('\n── a non-SOL asset still goes through the token program, untouched');
{
  const SPL = addr();
  const M2 = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,quote,quote_mint,status,venue,created_at,rex_pot,rex_paid)
              VALUES(?,?,?,?,?,?,?,?,?,0)`).run(M2, 'Spl Pair', 'SPLP', 'REX', SPL, 'live', 'dbc', Date.now(), 2_000_000);
  db.prepare('UPDATE tokens SET rex_pot=0 WHERE mint=?').run(MINT);
  const conn = makeConn();
  const r = await PO.payProtocol({ conn, CH, execute: true });
  ok(r.sent === 1, 'the SPL asset sends');
  const txn = decode(conn.sent[0]);
  const progs = new Set(txn.instructions.map((i) => i.programId.toBase58()));
  ok(progs.has(TOKEN_PROGRAM_ID.toBase58()), 'through the token program');
  ok(!progs.has(SystemProgram.programId.toBase58()), 'with no system transfers');
  ok(txn.instructions.length === 12, `an idempotent ATA create plus a transfer per leg (${txn.instructions.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
