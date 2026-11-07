// ⛔ A MULTIPLIER ON MONEY MAY NOT COME FROM A VALUE SOMEONE TYPED.
//
// STNKOG's buckets were credited 786.27 STONK against the 0.802 that was actually claimed off the
// pool. Nothing errored. `QUOTES.STONK.decimals` said 6; the mint says 9; `applySplit` believed the
// table. 980x, and the number looked wonderful on the dashboard.
//
// The damage landed downstream: the protocol distributor spends against `rex_pot`, so it asked the
// chain to send 156.45 STONK out of a wallet holding 0.802. Insufficient funds — nine times over,
// 48 dead transactions from 7 Oct to 9 Oct, each one paying a network fee to accomplish nothing.
//
// The table had been wrong before, for SOL, by the same 1000x. Fixing the entry fixes one asset;
// taking the figure off the chain fixes the class.
//
//   node tools/split_decimals_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-sd-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'sd.sqlite';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const addr = () => Keypair.generate().publicKey.toBase58();

const { db } = await import('../lib/db.mjs');
const FEES = await import('../lib/fees.mjs');
const { QUOTES } = await import('../lib/prices.mjs');

// STONK as it really is: 9 decimals on chain. The claim is the real one — 802313916 raw units,
// which is 0.802313916 STONK, the exact balance the fee claimer was found holding.
const STONK_MINT = QUOTES.STONK.mint;
const RAW = 802313916n;
const TRUTH = 0.802313916;

const mk = (sym) => {
  const mint = addr();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,quote,quote_mint,status,venue,created_at,
                                 holder_bps,vault_bps,burn_bps,buyback_bps,rex_bps)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(mint, sym, sym, 'STONK', STONK_MINT, 'live', 'dbc', Date.now(), 150, 50, 50, 50, 9700);
  return mint;
};
const claimFor = (mint, sig) => {
  FEES.recordClaim({ sig, mint, pool: addr(), side: 'partner', quoteAmount: RAW, baseAmount: 0n, quoteMint: STONK_MINT });
  return FEES.unsplit().find((c) => c.sig === sig);
};
const credited = (mint) => {
  const t = db.prepare('SELECT yield_pool,vault_pot,burn_pot,buyback_pot,rex_pot FROM tokens WHERE mint=?').get(mint);
  return t.yield_pool + t.vault_pot + t.burn_pot + t.buyback_pot + t.rex_pot;
};

console.log('── ⛔ AN UNVERIFIED QUOTE IS NOT CREDITED AT ALL');
{
  const mint = mk('UNVER');
  const sig = 'sigA' + addr().slice(0, 20);
  const claim = claimFor(mint, sig);
  const r = FEES.applySplit(claim);
  ok(r === null, 'it refuses rather than reaching for the table');
  ok(credited(mint) === 0, 'not one bucket moved');
  const row = db.prepare('SELECT split_at FROM fee_claims WHERE sig=?').get(sig);
  ok(row.split_at === null, '⛔ and the claim stays UNSPLIT, so the next crank run finishes it — a delay, not a loss');
  ok(FEES.unsplit().some((c) => c.sig === sig), 'it is still in the unsplit queue');
}

console.log('\n── once the mint has been read, the SAME claim credits the real amount');
{
  const mint = mk('VER');
  const sig = 'sigB' + addr().slice(0, 20);
  const claim = claimFor(mint, sig);
  // A connection that answers the way the chain does for this mint.
  const conn = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } }) };
  const d = await FEES.verifyDecimals(conn, STONK_MINT);
  ok(d === 9, 'verifyDecimals reads 9 off the mint');
  ok(FEES.decimalsFor(STONK_MINT) === 9, 'and remembers it, because applySplit has to stay synchronous');
  ok(FEES.applySplit(claim) !== null, 'now it splits');
  ok(near(credited(mint), TRUTH), `credited ${credited(mint).toFixed(9)} — the 0.802313916 that was actually claimed`);
  ok(!near(credited(mint), TRUTH * 1000, 1), '⛔ and NOT the 802.3 the 6dp table would have produced');
}

console.log('\n── a failed chain read is not cached, or one bad moment poisons the process');
{
  const dead = { getParsedAccountInfo: async () => { throw new Error('429'); } };
  const other = addr();
  ok(await FEES.verifyDecimals(dead, other) === null, 'a read that throws answers null');
  ok(FEES.decimalsFor(other) === null, 'and nothing was remembered');
  const live = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 8 } } } } }) };
  ok(await FEES.verifyDecimals(live, other) === 8, 'so the next attempt can still succeed');
}

console.log('\n── an explicit override still wins, for the operator repairing bad history');
{
  const mint = mk('OVER');
  const sig = 'sigC' + addr().slice(0, 20);
  const claim = claimFor(mint, sig);
  ok(FEES.applySplit(claim, 6) !== null, 'a caller that passes the decimals is obeyed');
  ok(near(credited(mint), 802.313916, 1e-4), `credited at 6dp on request (${credited(mint).toFixed(6)})`);
}

console.log('\n── every quote in the table agrees with its mint on chain');
{
  // The table is still what the SITE prices with, so a disagreement is a live bug even now that
  // the split no longer trusts it. These are the figures read from mainnet on 9 Oct.
  const CHAIN = { STONK: 9, ZCAT: 9, ZEC: 8, REX: 6, DOGE: 8, WIF: 6, SOL: 9, NVDAx: 8, GLDx: 8, TAO: 9 };
  const wrong = Object.entries(CHAIN).filter(([s, d]) => QUOTES[s] && QUOTES[s].decimals !== d);
  ok(wrong.length === 0, wrong.length ? `⛔ ${wrong.map(([s, d]) => `${s} table=${QUOTES[s].decimals} chain=${d}`).join(', ')}`
    : 'all ten quotes that have ever carried a fee claim match');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
