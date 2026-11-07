// Holdings, reconciled against the chain — and the one rule that must never bend.
//
// ⛔ A FAILED READ IS NOT A BALANCE OF ZERO. `heldOf` returns null when it could not reach the
// chain, and a null has to leave the row untouched. On the day this was written, production's RPC
// key was answering 401 to every method; a reconcile that read null as zero would have deleted
// every holding on the site in one sweep.
//
//   node tools/reconcile_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-rc-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'rc.sqlite';
process.env.RPC_URL = 'https://mainnet.example.com/?api-key=0123456789012345678901234567890123456';
process.env.RECONCILE_MS = '0';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { db } = await import('../lib/db.mjs');
const R = await import('../lib/reconcile.mjs');

const W = 'HolderWalletAAA';
const MINT = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAPER = 'MintPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
const seed = (mint, venue, amount) => {
  db.prepare(`INSERT OR REPLACE INTO tokens(mint,symbol,name,creator,quote,quote_mint,venue,price,status,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`).run(mint, 'TST', 'Test', W, 'SOL', 'So11111111111111111111111111111111111111112', venue, 1, 'live', Date.now());
  db.prepare('INSERT OR REPLACE INTO holdings(wallet,mint,amount,cost,realized,yield_earned,held_since) VALUES(?,?,?,0,0,0,?)')
    .run(W, mint, amount, Date.now());
};
const amountOf = (mint) => db.prepare('SELECT amount FROM holdings WHERE wallet=? AND mint=?').get(W, mint)?.amount;

// The chain is injected rather than stubbed: an ES module namespace is frozen, so a test that
// tried to overwrite CH.heldOf would throw before asserting anything.
let asked = 0, paused = false, reply = null;
const chain = {
  enabled: () => true,
  rpcPaused: () => paused,
  heldOf: async () => { asked++; return typeof reply === 'function' ? reply() : reply; },
};
const stub = (held) => { reply = held; };

console.log('── ⛔ AN UNREADABLE CHAIN CHANGES NOTHING');
{
  seed(MINT, 'dbc', 31_704_980);
  stub(null);                                   // exactly what a 401 looks like to this code
  R.__resetFor();
  const out = await R.reconcileWallet(W, { chain });
  ok(amountOf(MINT) === 31_704_980, 'the holding survived a completely unreachable RPC');
  ok(out.unknown === 1 && out.cleared === 0 && out.fixed === 0, 'reported as unknown, not as zero');
}

console.log('\n── a drifted mirror is corrected to what the chain says');
{
  R.__resetFor();
  stub({ total: 12_345_678_000_000n, decimals: 6 });
  await R.reconcileWallet(W, { chain });
  ok(Math.abs(amountOf(MINT) - 12_345_678) < 1, `corrected to ${amountOf(MINT)}`);
}

console.log('\n── a position that was sold elsewhere is cleared');
{
  R.__resetFor();
  stub({ total: 0n, decimals: 6 });
  const out = await R.reconcileWallet(W, { chain });
  ok(amountOf(MINT) === 0, 'a wallet holding none of it now reads zero');
  ok(out.cleared === 1, 'and it is counted as cleared, not as a correction');
}

console.log('\n── rounding noise does not churn the table');
{
  seed(MINT, 'dbc', 1_000_000);
  R.__resetFor();
  stub({ total: 1_000_000_200_000n, decimals: 6 });   // 0.02% different
  const out = await R.reconcileWallet(W, { chain });
  ok(out.fixed === 0 && amountOf(MINT) === 1_000_000, 'a 0.02% difference was left alone');
}

console.log('\n── ⛔ A PAPER HOLDING HAS NO ON-CHAIN COUNTERPART AND MUST NOT BE READ');
{
  seed(PAPER, 'curve', 500_000);
  R.__resetFor();
  asked = 0; stub({ total: 0n, decimals: 6 });
  await R.reconcileWallet(W, { chain });
  ok(amountOf(PAPER) === 500_000, 'the paper holding is untouched');
  ok(asked === 1, `only the on-chain row was read (${asked} read, not 2)`);
}

console.log('\n── a paused breaker means we do not ask at all');
{
  R.__resetFor();
  asked = 0; paused = true;
  const out = await R.reconcileWallet(W, { chain });
  ok(asked === 0 && out.checked === 0, 'nothing was read while the chain layer is standing down');
  paused = false;
}

console.log('\n── the cooldown stops a page refresh becoming an RPC storm');
{
  process.env.RECONCILE_MS = '60000';
  const R2 = await import(`../lib/reconcile.mjs?cool=${Date.now()}`);
  seed(MINT, 'dbc', 2_000_000);     // the earlier cases cleared this row; there has to be work to do
  asked = 0; stub({ total: 1_000_000_000_000n, decimals: 6 });
  await R2.reconcileWallet(W, { chain });
  const first = asked;
  ok(first > 0, `${first} row(s) read on the first pass`);
  ok(R2.dueFor(W) === false, 'the wallet is not due again immediately');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
