// Open liquidity: whose money is it, and can they get it back?
//
// ⛔ THE BUG THIS FILE EXISTS TO PREVENT. `lib/vault2.mjs` deposits the PROTOCOL's own money with
// `permanentLock: true`, and that is correct there — locked liquidity is what makes a launch
// rug-resistant, and the site promises exactly that. `lib/lp.mjs` does the same job for the PUBLIC,
// and the two are one copied default apart from silently taking a depositor's money and making it
// unwithdrawable with no way on earth to undo it. There is no flag to get wrong: the public path
// cannot lock a position even if a caller asks it to, and this asserts that directly.
//
//   node tools/lp_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';

const { BN } = anchorPkg;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-lp-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'lp.sqlite';

const LP = await import('../lib/lp.mjs');
const V2 = await import('../lib/vault2.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const POOL = Keypair.generate().publicKey.toBase58();
const MINT_A = Keypair.generate().publicKey;
const MINT_B = Keypair.generate().publicKey;
const OWNER = Keypair.generate().publicKey.toBase58();

const poolState = {
  tokenAMint: MINT_A, tokenBMint: MINT_B, tokenAFlag: 0, tokenBFlag: 1,
  sqrtPrice: new BN('18446744073709551616'),
  sqrtMinPrice: new BN('4295048016'), sqrtMaxPrice: new BN('79226673521066979257578248091'),
  liquidity: new BN('5000000000000'),
};

let lastAdd = null, lastRemove = null;
const stub = {
  fetchPoolState: async () => poolState,
  fetchPositionState: async (k) => positionStates.get(k.toBase58()) ?? null,
  getDepositQuote: async () => ({ liquidityDelta: new BN('123456'), outputAmount: new BN('777000') }),
  createPositionAndAddLiquidity: async (p) => { lastAdd = p; return { transaction: async () => ({ ok: true }) }; },
  removeAllLiquidityAndClosePosition: async (p) => { lastRemove = p; return { transaction: async () => ({ ok: true }) }; },
  claimPositionFee: async () => ({ transaction: async () => ({ ok: true }) }),
  fetchPoolStatesByTokenMint: async () => ([
    { publicKey: new PublicKey(POOL), account: { ...poolState, liquidity: new BN('100') } },
    { publicKey: MINT_A, account: { ...poolState, liquidity: new BN('99999') } },
  ]),
  getPositionsByUserAndTokenMint: async () => ([
    { position: new PublicKey(POOL), positionNftAccount: MINT_A, positionState: { pool: new PublicKey(POOL), unlockedLiquidity: new BN('5'), permanentLockedLiquidity: new BN('0') } },
    { position: MINT_B, positionNftAccount: MINT_A, positionState: { pool: new PublicKey(POOL), unlockedLiquidity: new BN('0'), permanentLockedLiquidity: new BN('42') } },
  ]),
};
const positionStates = new Map();
const conn = { getSlot: async () => 1000 };

// The AMM client is memoised inside vault2, which is what makes a deposit testable without an RPC:
// substitute it once and every call in lp.mjs goes to the stub above.
V2.__setAmmForTest(stub);
ok((await V2.amm(conn)) === stub, 'the AMM client can be substituted for testing');

console.log('\n── public liquidity is never locked');
{
  const plan = await LP.planDeposit({ conn, pool: POOL, quoteAmount: 1_000_000n });
  await LP.buildAddLiquidity({ conn, owner: OWNER, plan });
  ok(lastAdd !== null, 'a deposit builds a transaction');
  // ⛔ The vault's deposit passes permanentLock. This one must not carry it in ANY form.
  ok(!('permanentLock' in lastAdd), 'the deposit params carry no permanentLock at all');
  ok(!JSON.stringify(Object.keys(lastAdd)).includes('ock'), `nothing in the params mentions locking (${Object.keys(lastAdd).join(', ')})`);
}

console.log('\n── a deposit says what the other side costs, before anyone signs');
{
  const plan = await LP.planDeposit({ conn, pool: POOL, quoteAmount: 2_000_000n });
  ok(plan.otherAmount === 777_000n, `the other side is quoted (${plan.otherAmount})`);
  ok(plan.tokenAMint === MINT_A.toBase58() && plan.tokenBMint === MINT_B.toBase58(), 'and both mints come back so the page can name them');
  let threw = null;
  try { await LP.planDeposit({ conn, pool: POOL, quoteAmount: 0n }); } catch (e) { threw = e.message; }
  ok(threw && /amount/i.test(threw), 'a zero deposit is refused in words rather than built');
}

console.log('\n── slippage protects the depositor, and padding only ever goes up');
{
  const plan = await LP.planDeposit({ conn, pool: POOL, quoteAmount: 1_000_000n });
  await LP.buildAddLiquidity({ conn, owner: OWNER, plan, slippageBps: 100 });
  const maxB = BigInt(lastAdd.maxAmountTokenB.toString());
  ok(maxB === 1_010_000n, `1% slippage raises the ceiling, never the floor (${maxB})`);
}

console.log('\n── withdrawal');
{
  positionStates.set(POOL, { permanentLockedLiquidity: new BN('0'), unlockedLiquidity: new BN('5') });
  await LP.buildWithdrawAll({ conn, owner: OWNER, pool: POOL, position: POOL, positionNftAccount: MINT_A.toBase58() });
  ok(lastRemove !== null, 'an unlocked position can be withdrawn and closed');

  // A locked position belongs to somebody else's rules; say so instead of letting the chain refuse.
  positionStates.set(MINT_B.toBase58(), { permanentLockedLiquidity: new BN('42'), unlockedLiquidity: new BN('0') });
  let threw = null;
  try { await LP.buildWithdrawAll({ conn, owner: OWNER, pool: POOL, position: MINT_B.toBase58(), positionNftAccount: MINT_A.toBase58() }); }
  catch (e) { threw = e.message; }
  ok(threw && /permanently locked/i.test(threw), `a locked position refuses in plain words — "${threw}"`);
}

console.log('\n── pools are discovered and ordered by depth, never guessed');
{
  const pools = await LP.poolsFor(conn, MINT_A.toBase58());
  ok(pools.length === 2, 'every pool holding the mint is returned');
  ok(BigInt(pools[0].liquidity) > BigInt(pools[1].liquidity), 'deepest first');
  const best = await LP.bestPoolFor(conn, MINT_A.toBase58());
  ok(best.pool === pools[0].pool, 'and bestPoolFor agrees with the ordering');
  ok(!pools.some((p) => p.state), 'the raw pool state is not leaked to callers that only need the summary');
}

console.log('\n── the pool scan is cached, because it is heavy enough to take the site down');
{
  // ⛔ fetchPoolStatesByTokenMint is a getProgramAccounts scan. Asked for wrapped SOL on mainnet it
  // does not return a long list — it throws "Cannot create a string longer than 0x1fffffe8
  // characters", and the next run exhausted the endpoint's entire data allowance. An uncached call
  // behind a public route anyone can hit with any mint is this morning's outage volunteered.
  LP.forgetPools();
  let scans = 0;
  const counted = { ...stub, fetchPoolStatesByTokenMint: async (...a) => { scans++; return stub.fetchPoolStatesByTokenMint(...a); } };
  V2.__setAmmForTest(counted);
  await LP.poolsFor(conn, MINT_A.toBase58());
  await LP.poolsFor(conn, MINT_A.toBase58());
  ok(scans === 1, `a repeat ask is served from cache (${scans} scan for 2 asks)`);

  // A crowd arriving at once must not each start their own scan.
  LP.forgetPools();
  scans = 0;
  await Promise.all(Array.from({ length: 8 }, () => LP.poolsFor(conn, MINT_A.toBase58())));
  ok(scans === 1, `eight simultaneous asks cost one scan (${scans})`);

  // ⛔ A FAILED SCAN MUST NOT BE REMEMBERED AS "NO POOLS". Caught on production minutes after
  // shipping: the route listed two $REX pools, the RPC was rate limited, the next scan failed, and
  // the empty answer was cached — so the page said "$REX has no DAMM v2 pool yet" about a pool it
  // had just shown. Same mistake as a burn panel reporting an empty pot because its upstream was
  // down, and worth being this careful about twice in one day.
  LP.forgetPools();
  const failing = { ...stub, fetchPoolStatesByTokenMint: async () => { throw new Error('413 data allowance'); } };
  V2.__setAmmForTest(failing);
  ok((await LP.poolsFor(conn, MINT_B.toBase58())).length === 0, 'a failed scan returns empty rather than throwing');

  // Now the good answer, then a failure: the good answer must survive.
  LP.forgetPools();
  V2.__setAmmForTest(stub);
  const good = await LP.poolsFor(conn, MINT_A.toBase58());
  ok(good.length === 2, 'a good scan is cached');
  LP.forgetPools(MINT_A.toBase58());
  V2.__setAmmForTest(failing);
  ok((await LP.poolsFor(conn, MINT_A.toBase58())).length === 0, 'with nothing remembered, a failure is honestly empty');

  // And with something remembered, a failure serves it rather than blanking the page.
  LP.forgetPools();
  V2.__setAmmForTest(stub);
  await LP.poolsFor(conn, MINT_A.toBase58());
  V2.__setAmmForTest(failing);
  const after = await LP.poolsFor(conn, MINT_A.toBase58());
  ok(after.length === 2, `a failure after a good scan keeps the good answer (${after.length} pools)`);
  V2.__setAmmForTest(stub);
}

console.log('\n── decimals are retried on every serve, not frozen into the cache');
{
  // ⛔ The scan and the decimal reads fail independently. Baking decimals in at scan time means one
  // unlucky moment leaves the amount box refusing to convert for the whole five-minute TTL, about a
  // pool the page is perfectly happy to show.
  LP.forgetPools();
  let decCalls = 0;
  const noDecimals = { ...stub };
  conn.getParsedAccountInfo = async () => { decCalls++; throw new Error('rpc paused'); };
  V2.__setAmmForTest(noDecimals);
  const first = await LP.poolsFor(conn, MINT_A.toBase58());
  ok(first[0].tokenBDecimals == null, 'a failed decimal read leaves it unknown rather than guessing');

  // Now the RPC recovers. The SAME cached pool list must pick the decimals up.
  conn.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { decimals: 9 } } } } });
  const second = await LP.poolsFor(conn, MINT_A.toBase58());
  ok(second[0].tokenBDecimals === 9, `a cached list picks decimals up once the chain answers (${second[0].tokenBDecimals})`);
  delete conn.getParsedAccountInfo;
  V2.__setAmmForTest(stub);
}

console.log('\n── a position list tells the truth about what can be withdrawn');
{
  const list = await LP.positionsOf(conn, OWNER, MINT_A.toBase58());
  ok(list.length === 2, 'both positions are listed');
  ok(list.filter((p) => p.permanentlyLocked).length === 1, 'the locked one is flagged, so the page can withhold its Withdraw button');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
