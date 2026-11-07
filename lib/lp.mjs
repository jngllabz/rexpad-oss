// Liquidity, open to everyone.
//
// REX Chain already deposits into Meteora DAMM v2 — that is what `lib/vault2.mjs` does with the
// protocol's own 5% vault leg. This is the same machinery pointed the other way: anyone can add
// liquidity to a pool, earn their share of every swap fee that passes through it, and take it out
// again whenever they want.
//
// ⛔ THE ONE DIFFERENCE THAT MATTERS, AND IT IS NOT A SETTING. The vault deposits with
// `permanentLock: true`, because locked liquidity is what makes a launch rug-resistant and the
// protocol is depositing its own money for ever. A member of the public depositing their own money
// must be able to get it back. A public LP position is NEVER permanently locked, and that is
// asserted in tools/lp_test.mjs rather than left to a default somebody might copy from the vault.
//
// WHAT AN LP IS ACTUALLY SIGNING UP FOR, said once here so every surface can repeat it honestly:
// supplying liquidity is not a deposit account. You take both sides of the pair, your position
// changes shape as the price moves, and if the coin falls you end up holding more of it than you
// started with — that is impermanent loss, and no amount of fee income is guaranteed to cover it.
// Nothing in this file hides that, and the page does not either.
import { PublicKey } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
import { warn } from './config.mjs';
import { amm } from './vault2.mjs';

const { BN } = anchorPkg;
const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const progOf = (flag) => (flag === 1 ? TOKEN_2022 : TOKEN_LEGACY);
const str = (v) => (v?.toString?.() ?? String(v ?? '0'));

/**
 * Every DAMM v2 pool holding this mint, deepest first.
 *
 * ⛔ DISCOVERED, NOT CONFIGURED. `vault2.rexPool()` refuses to act without an explicit REX_POOL
 * because depositing the protocol's money into the wrong pool is unrecoverable — and REX_POOL has
 * never been set, so there is no pool address in this deployment to point a page at. Guessing one
 * would be the same mistake with somebody else's money. The chain knows which pools hold a mint, so
 * it is asked, and the answer carries the reserves that justify the ordering.
 *
 * A mint can legitimately appear in several pools. The deepest is offered first because that is
 * where a deposit does the most good and suffers the least, but every one is returned so the choice
 * stays the depositor's.
 */
/**
 * A mint's decimals, cached for ever because they cannot change.
 *
 * ⛔ THE PAGE CANNOT ASSUME SIX. It did, and that is a money bug: the amount box converts what
 * somebody types into raw units, so a SOL-paired pool (9 decimals) would turn "1 SOL" into 1,000,000
 * lamports — a thousandth of what they meant — and an xStock pair (8) would be out by a hundred.
 * The figure has to come from the mint.
 */
const decCache = new Map();
export async function decimalsOf(conn, mint) {
  const key = String(mint);
  if (decCache.has(key)) return decCache.get(key);
  // ⛔ ONE ATTEMPT WAS NOT ENOUGH, AND IT COST A LAUNCH. A single getParsedAccountInfo that met one
  // 429 returned null, and the launch route turns null into "Could not read the pair token's
  // decimals from the chain just now" and refuses — correctly, since guessing is the bug this
  // whole path exists to prevent, but the read should not have given up that easily. Fco hit it on
  // a DOPE pair while the breaker was opening and closing under background load.
  //
  // ⛔ NOT `readWithRetry`: that helper retries on any falsy value, and 0 IS A VALID DECIMALS.
  // A zero-decimal mint would be retried four times and then reported as unreadable.
  for (let i = 0; i < 4; i++) {
    try {
      const info = await conn.getParsedAccountInfo(new PublicKey(key));
      const d = info?.value?.data?.parsed?.info?.decimals;
      if (Number.isInteger(d)) { decCache.set(key, d); return d; }
    } catch (e) { if (i === 3) warn('lp decimals', key.slice(0, 8), e.message); }
    if (i < 3) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  // Not cached: an unknown is a failed read, and remembering it would make the amount box wrong for
  // as long as the process lives.
  return null;
}

/**
 * Read the decimals of every mint we already know about, in one batched call, and cache them.
 *
 * ⛔ WHY THIS EXISTS: A LAUNCH SHOULD NOT DEPEND ON THE RPC ANSWERING AT THAT INSTANT. The retry
 * above makes a transient 429 survivable, but a launch is the worst moment to be making a live
 * read at all — the person is at the end of a form with money ready. Reading the quote assets once,
 * ahead of time, means the launch path hits a cache that was filled from the chain rather than a
 * network call that can fail.
 *
 * ⛔ AND THIS IS NOT "TRUST THE TABLE". The decimals still come from the mint account; the table is
 * only the list of WHICH mints to read. That distinction is the whole bug: prices.mjs had STONK and
 * ZCAT at 6 when the chain says 9, and a launch priced on those opened at a $5 market cap.
 *
 * ⛔ IT DOES NOT JUDGE THE TABLE, DELIBERATELY. `auditQuoteDecimals` in prices.mjs already reads
 * every quote, corrects `q.decimals` in memory and shouts when the two disagree. A second copy of
 * that comparison here would be two detectors to keep in step, and the day they drift is the day
 * one of them is believed. One owner for the mismatch question; this one only fills the cache.
 *
 * One batched call rather than 61 round trips, because a burst of single reads is itself a good
 * way to earn the 429s this is meant to make survivable.
 */
export async function warmDecimals(conn, mints) {
  const list = [...new Set((mints || []).map(String).filter(Boolean))];
  if (!list.length) return 0;
  let read = 0;
  for (let i = 0; i < list.length; i += 100) {
    const slice = list.slice(i, i + 100);
    let infos = null;
    try { infos = await conn.getMultipleAccountsInfo(slice.map((m) => new PublicKey(m))); }
    catch (e) { warn('warm decimals', e.message); continue; }
    slice.forEach((m, n) => {
      // Mint layout: decimals is byte 44.
      const d = infos?.[n]?.data?.[44];
      if (!Number.isInteger(d)) return;      // a mint that did not come back is simply not cached
      decCache.set(m, d);
      read++;
    });
  }
  return read;
}

const poolCache = new Map();           // mint -> { at, pools }
const poolInflight = new Map();        // mint -> Promise, so a crowd costs one scan
const POOL_TTL = Number(process.env.LP_POOL_TTL_MS || 300_000);

export async function poolsFor(conn, mint) {
  const key = String(mint);
  const hit = poolCache.get(key);
  if (hit && Date.now() - hit.at < POOL_TTL) return withDecimals(conn, hit.pools);
  if (poolInflight.has(key)) return poolInflight.get(key);
  const run = (async () => {
    try { return await scanPools(conn, key); }
    finally { poolInflight.delete(key); }
  })();
  poolInflight.set(key, run);
  const pools = await run;
  // ⛔ A FAILED SCAN IS NOT "THIS MINT HAS NO POOLS", AND MUST NOT BE REMEMBERED AS ONE.
  //
  // Caught live within minutes of shipping: the route returned two $REX pools, the RPC was then
  // rate limited, the next scan failed, and the empty result was cached — so /liquidity told
  // everyone "$REX has no DAMM v2 pool yet" for five minutes about a pool it had just listed. That
  // is the same mistake as the burn panel reporting an empty pot because the service behind it
  // could not answer, and it is worth being this careful about twice in one day.
  //
  // Only a scan that actually completed is cached. A failure serves the last good answer if we have
  // one, and an empty list if we have never had one — never a zero dressed up as a measurement.
  if (pools === null) return withDecimals(conn, hit?.pools || []);
  poolCache.set(key, { at: Date.now(), pools });
  return withDecimals(conn, pools);
}

/**
 * Decimals are attached when a list is SERVED, not when it is scanned.
 *
 * ⛔ BAKING THEM INTO THE CACHE MAKES A TRANSIENT FAILURE LAST FIVE MINUTES. The pool scan and the
 * decimal reads fail independently — the scan can succeed while the breaker opens a moment later —
 * and a cached list carrying nulls leaves the amount box refusing to convert for the whole TTL,
 * about a pool it is perfectly happy to display. Decimals have their own permanent cache (they
 * cannot change), so retrying costs one RPC read the first time it works and nothing afterwards.
 */
async function withDecimals(conn, pools) {
  for (const p of pools) {
    if (p.tokenADecimals == null) p.tokenADecimals = await decimalsOf(conn, p.tokenAMint);
    if (p.tokenBDecimals == null) p.tokenBDecimals = await decimalsOf(conn, p.tokenBMint);
  }
  return pools;
}

/**
 * ⛔ THIS IS A getProgramAccounts SCAN, AND IT IS EXPENSIVE ENOUGH TO TAKE THE SITE DOWN.
 *
 * Asking it for wrapped SOL on mainnet does not return a long list — it throws "Cannot create a
 * string longer than 0x1fffffe8 characters", because SOL is in so many pools that the RPC response
 * overflows a V8 string. The run after that exhausted the endpoint's whole data allowance outright.
 * This morning's outage was a storm of exactly this kind of call starving the web server, so an
 * uncached one behind a public route that anyone can hit with any mint is the same bug volunteered.
 *
 * Hence the five-minute cache, the single in-flight scan per mint however many people ask at once,
 * and the empty list on failure. Which pools hold a mint changes when a coin graduates, which is
 * rare; five minutes of staleness costs nothing and the alternative has already cost a morning.
 */
async function scanPools(conn, mint) {
  const a = await amm(conn);
  let found = [];
  // null, not [] — the caller has to be able to tell "nothing holds this mint" from "we could not
  // ask", because only one of those is safe to remember.
  try { found = await a.fetchPoolStatesByTokenMint(new PublicKey(mint)); }
  catch (e) { warn('lp pools', e.message); return null; }
  const out = (found || [])
    .map((p) => {
      const s = p.account ?? p.poolState ?? p;
      return {
        pool: str(p.publicKey ?? p.pool),
        tokenAMint: str(s.tokenAMint),
        tokenBMint: str(s.tokenBMint),
        // Liquidity is the pool's own measure of depth, and the only one available without pricing
        // both sides. Used for ordering, never presented as a dollar figure it is not.
        liquidity: str(s.liquidity),
        sqrtPrice: str(s.sqrtPrice),
        // ⛔ The raw pool state deliberately does NOT travel with this. It is full of BNs that
        // serialize into nonsense, and the route had to remember to strip it — a thing every future
        // caller would also have to remember. `planDeposit` re-reads the pool anyway, because a
        // range priced off a stale sqrtPrice is a deposit that lands wrong.
      };
    })
    .sort((x, y) => (BigInt(y.liquidity || 0) > BigInt(x.liquidity || 0) ? 1 : -1));
  return out;
}

/** Clears the discovery cache. For tests, and for an admin who has just watched a coin graduate. */
export const forgetPools = (mint = null) => (mint ? poolCache.delete(String(mint)) : poolCache.clear());

/** The deepest pool for a mint, or null. Null means "no pool", never "pick one for me". */
export async function bestPoolFor(conn, mint) {
  const [first] = await poolsFor(conn, mint);
  return first || null;
}

/**
 * What a deposit of `quoteAmount` would need and get.
 *
 * Full range rather than a band: an ordinary depositor is not choosing a price view, and a
 * concentrated range that spot walks out of stops earning without saying so. Full range is live at
 * every price, which is the behaviour someone who clicked "add liquidity" is expecting.
 *
 * ⛔ IT NEEDS BOTH SIDES. The pool's maths decides how much of the other token the deposit requires,
 * and that figure is returned so the page can say "this also needs N $COIN" BEFORE anyone signs.
 * The vault avoids this by sitting below spot in a quote-only bid; a public LP who wants to earn on
 * every trade cannot.
 */
export async function planDeposit({ conn, pool, quoteAmount, isTokenA = false }) {
  const a = await amm(conn);
  const state = await a.fetchPoolState(new PublicKey(String(pool)));
  if (!state) throw new Error('that pool does not exist');
  if (!(BigInt(quoteAmount) > 0n)) throw new Error('enter an amount first');
  const minSqrtPrice = state.sqrtMinPrice ?? state.minSqrtPrice;
  const maxSqrtPrice = state.sqrtMaxPrice ?? state.maxSqrtPrice;
  const q = await a.getDepositQuote({
    inAmount: new BN(String(quoteAmount)),
    isTokenA,
    minSqrtPrice, maxSqrtPrice, sqrtPrice: state.sqrtPrice,
  });
  return {
    pool: String(pool), state, minSqrtPrice, maxSqrtPrice,
    inAmount: BigInt(quoteAmount),
    isTokenA,
    liquidityDelta: q.liquidityDelta,
    // How much of the OTHER token the depositor must also supply.
    otherAmount: BigInt(q.outputAmount?.toString?.() ?? 0),
    tokenAMint: str(state.tokenAMint),
    tokenBMint: str(state.tokenBMint),
  };
}

/**
 * The transaction that opens a public LP position.
 *
 * ⛔ NEVER PERMANENTLY LOCKED. `vault2.buildBidDeposit` defaults `permanentLock` to true because the
 * protocol's own liquidity is supposed to be unpullable for ever — that is the promise the site
 * makes about a launch. Copying that default here would quietly take a depositor's money and make
 * it unwithdrawable with no way to undo it. There is deliberately no flag: this function cannot
 * lock a position even if a caller asks.
 *
 * `slippageBps` becomes the thresholds the pool checks against, so a price that moves between the
 * plan and the signature costs the depositor a failed transaction rather than a worse position.
 */
export async function buildAddLiquidity({ conn, owner, plan, slippageBps = 100 }) {
  const a = await amm(conn);
  const { Keypair } = await import('@solana/web3.js');
  const positionNft = Keypair.generate();
  const s = plan.state;
  const bps = BigInt(Math.max(0, Math.min(5000, Math.round(slippageBps))));
  const pad = (v) => new BN(String((BigInt(v) * (10_000n + bps)) / 10_000n));

  const aAmt = plan.isTokenA ? plan.inAmount : plan.otherAmount;
  const bAmt = plan.isTokenA ? plan.otherAmount : plan.inAmount;

  const tx = await a.createPositionAndAddLiquidity({
    owner: new PublicKey(owner),
    pool: new PublicKey(plan.pool),
    positionNft: positionNft.publicKey,
    liquidityDelta: plan.liquidityDelta,
    maxAmountTokenA: pad(aAmt),
    maxAmountTokenB: pad(bAmt),
    tokenAAmountThreshold: pad(aAmt),
    tokenBAmountThreshold: pad(bAmt),
    tokenAMint: s.tokenAMint, tokenBMint: s.tokenBMint,
    tokenAProgram: progOf(s.tokenAFlag), tokenBProgram: progOf(s.tokenBFlag),
  });
  return { tx, positionNft };
}

/**
 * A wallet's LP positions in one pool's token, with what each has earned.
 *
 * Fees come from the chain. A figure we computed from our own trade table would drift from what the
 * pool will actually pay out, and the number people check against their wallet is the one the pool
 * believes.
 */
export async function positionsOf(conn, owner, mint = null) {
  const a = await amm(conn);
  let list = [];
  try {
    list = mint
      ? await a.getPositionsByUserAndTokenMint(new PublicKey(owner), new PublicKey(String(mint)))
      : await a.getPositionsByUser(new PublicKey(owner));
  } catch (e) { warn('lp positions', e.message); return []; }
  const out = [];
  for (const p of list || []) {
    const st = p.positionState ?? p.account ?? {};
    const locked = str(st.permanentLockedLiquidity) !== '0';
    out.push({
      position: str(p.position ?? p.publicKey),
      positionNftAccount: str(p.positionNftAccount ?? ''),
      pool: st.pool ? str(st.pool) : null,
      liquidity: str(st.unlockedLiquidity),
      // Surfaced rather than hidden: a locked position cannot be withdrawn, so a page that offers a
      // Withdraw button on one is lying. Public deposits are never locked, but a wallet may hold a
      // locked position from somewhere else entirely.
      permanentlyLocked: locked,
      feeA: str(st.feeAPending ?? st.metrics?.totalClaimedAFee ?? 0),
      feeB: str(st.feeBPending ?? st.metrics?.totalClaimedBFee ?? 0),
    });
  }
  return out;
}

/** Claim what a position has earned, without touching the position itself. */
export async function buildClaimFees({ conn, owner, pool, position, positionNftAccount }) {
  const a = await amm(conn);
  return a.claimPositionFee({
    owner: new PublicKey(owner), pool: new PublicKey(pool),
    position: new PublicKey(position), positionNftAccount: new PublicKey(positionNftAccount),
  });
}

/**
 * Take it all back out and close the position.
 *
 * ⛔ REFUSES ON A LOCKED POSITION rather than building a transaction the chain will reject. The
 * error a depositor gets back should say what is true — this position is locked — not a program
 * code from three layers down.
 */
export async function buildWithdrawAll({ conn, owner, pool, position, positionNftAccount }) {
  const a = await amm(conn);
  const poolState = await a.fetchPoolState(new PublicKey(String(pool)));
  if (!poolState) throw new Error('that pool does not exist');
  const positionState = await a.fetchPositionState(new PublicKey(String(position)));
  if (!positionState) throw new Error('that position does not exist');
  if (str(positionState.permanentLockedLiquidity) !== '0') {
    throw new Error('this position is permanently locked, so its liquidity cannot be withdrawn');
  }
  return a.removeAllLiquidityAndClosePosition({
    owner: new PublicKey(owner),
    position: new PublicKey(String(position)),
    positionNftAccount: new PublicKey(String(positionNftAccount)),
    poolState, positionState,
    // Zero thresholds: a full withdrawal takes whatever the position is worth at the moment it
    // lands. A floor here would mean a position that cannot be exited while the price is moving,
    // which is precisely when somebody wants out.
    tokenAAmountThreshold: new BN(0),
    tokenBAmountThreshold: new BN(0),
    vestings: [],
    currentPoint: new BN(await conn.getSlot()),
  });
}
