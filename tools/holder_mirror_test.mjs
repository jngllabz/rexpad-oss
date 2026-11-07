// The holder mirror, and the ghost positions it was leaving behind.
//
// ⛔ 23 OF 82 ON-CHAIN HOLDINGS ON MAINNET — 28% — WERE BAGS THE WALLET NO LONGER HELD. They show
// in portfolios, and `holdings` is the table the reward epoch reads, so every ghost was taking a
// share from people who actually still hold. Two causes, compounding:
//
//   · holdersFromChain returns NULL when the scan was refused and [] when it genuinely found
//     nobody. `if (!rows?.length) return 0` bailed on both — so the one run that would clear a
//     coin everybody had sold out of is exactly the run that was skipped.
//   · The mirror only re-ran for a coin that had traded SINCE the last mirror, judged from our own
//     trades table. These coins trade on DexScreener, Jupiter and any terminal; a sale made
//     anywhere else never reaches that table, so the mirror never ran again.
//
//   node tools/holder_mirror_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-hm-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'hm.sqlite';
process.env.RPC_URL = 'https://mainnet.example.com/?api-key=0123456789012345678901234567890123456';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { db } = await import('../lib/db.mjs');
const IDX = await import('../lib/dbcindex.mjs');

// ⛔ REAL KEYS. Hand-written stand-ins like 'HolderAAA…' are not base58 — the alphabet excludes
// 0, O, I and lowercase l, and "Holder" has one. The decode throws inside the scan, which looks
// exactly like a chain failure and makes the test pass or fail for the wrong reason.
const { Keypair } = await import('@solana/web3.js');
const MINT = Keypair.generate().publicKey.toBase58();
const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
db.prepare(`INSERT OR REPLACE INTO tokens(mint,symbol,name,creator,quote,quote_mint,venue,price,status,created_at,dbc_pool)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(MINT, 'GHOST', 'Ghost', A, 'SOL', 'So11111111111111111111111111111111111111112', 'dbc', 1, 'live', Date.now(), 'Pool1111111111111111111111111111111111111111');
const setHold = (w, amt) => db.prepare('INSERT OR REPLACE INTO holdings(wallet,mint,amount,cost,realized,yield_earned,held_since) VALUES(?,?,?,0,0,0,?)').run(w, MINT, amt, Date.now());
const amountOf = (w) => db.prepare('SELECT amount FROM holdings WHERE wallet=? AND mint=?').get(w, MINT)?.amount;

// A connection stub; what holdersFromChain returns is what mirrorHolders must interpret.
const MET = { poolVaultsOf: async () => ({ base: null, quote: null }) };
const withScan = (result) => {
  const real = IDX.holdersFromChain;
  // mirrorHolders calls the module's own export, so patch the module record via a wrapper module.
  return result;
};

console.log('── ⛔ AN EMPTY SCAN MEANS EVERYBODY SOLD, AND MUST CLEAR THEM');
{
  setHold(A, 1000); setHold(B, 500);
  // getProgramAccounts answers, and finds nothing: every holder is gone.
  const conn = { getProgramAccounts: async () => [], getAccountInfo: async () => null };
  await IDX.mirrorHolders(conn, db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT), MET);
  ok(amountOf(A) === 0 && amountOf(B) === 0, 'both stale positions were cleared');
}

console.log('\n── ⛔ A REFUSED SCAN MEANS NOTHING, AND MUST CLEAR NOBODY');
{
  setHold(A, 1000); setHold(B, 500);
  // Every token program throws: we learned nothing about who holds this.
  // ⛔ THE DANGEROUS PAIR: the scan is refused AND the cache from the previous case is empty, so
  // the fallback hands back [] and a naive mirror zeroes everybody over a rate limit.
  const conn = { getProgramAccounts: async () => { throw new Error('429 Too Many Requests'); }, getAccountInfo: async () => null };
  await IDX.mirrorHolders(conn, db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT), MET);
  ok(amountOf(A) === 1000 && amountOf(B) === 500,
    'both positions survive a refused RPC even with an empty cache behind it');
}

console.log('\n── a fresh scan that finds one of two clears only the other');
{
  const bs58 = (await import('bs58')).default;
  setHold(A, 1000); setHold(B, 500);
  const mk = (owner, raw) => {
    const b = Buffer.alloc(40);
    Buffer.from(bs58.decode(owner)).copy(b, 0, 0, 32);
    b.writeBigUInt64LE(BigInt(raw), 32);
    return { pubkey: { toBase58: () => 'Acct' + owner.slice(0, 6) }, account: { data: b } };
  };
  let first = true;
  const conn = { getProgramAccounts: async () => { if (first) { first = false; return [mk(A, 1000n * 10n ** 6n)]; } return []; }, getAccountInfo: async () => null };
  await IDX.mirrorHolders(conn, db.prepare('SELECT * FROM tokens WHERE mint=?').get(MINT), MET);
  ok(amountOf(A) === 1000, `A still holds (${amountOf(A)})`);
  ok(amountOf(B) === 0, 'B, who was not in the scan, was cleared');
}

console.log('\n── ⛔ AND THE MIRROR RUNS EVEN WHEN WE SAW NO TRADE');
{
  const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  ok(/const stale = Date\.now\(\) - mirroredAt > 30 \* 60_000;/.test(src),
    'there is a heartbeat independent of our own trades table');
  ok(/tradedSince \|\| stale \|\| !mirroredAt/.test(src), 'and it is part of the condition');
  ok(/trades we never see|sales we are never told about/i.test(src),
    'with the reason stated: these coins trade on venues we do not index');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
