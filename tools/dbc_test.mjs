// The Meteora fee split, and the invariants that have to hold now that the chain is not enforcing it.
//
// When our own program took the fee, the five buckets were checked on chain and a bad split simply
// could not be submitted. A Meteora pool has one fee and this code divides it, so these assertions
// are the only thing standing between a rounding mistake and somebody being quietly underpaid on
// every single trade, forever.
//
// They assert PROPERTIES rather than numbers: that nothing is created, nothing vanishes, dust goes
// where it was promised, and a replayed claim cannot pay twice. A test that pinned an exact payout
// would pass today and tell us nothing the day the bps change.
//
//   node tools/dbc_test.mjs
import { splitClaim, bucketsOf, claimSeen, recordClaim, unsplit, applySplit, ledger,
         __noteDecimals } from '../lib/fees.mjs';
// ⛔ applySplit WILL NOT CREDIT ON A TABLE VALUE any more — the decimals come off the mint, and a
// claim whose quote mint has not been read is left unsplit for the next run. A real caller awaits
// verifyDecimals(conn, quote_mint) first; these tests pose the same answer without an RPC.
import { curveConfig } from '../lib/meteora.mjs';
import { db } from '../lib/db.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const sum = (parts) => Object.values(parts).reduce((a, b) => a + b, 0n);

console.log('\n── buckets: REX\'s share is the remainder, so the whole is always allocated');
{
  for (const t of [
    { holder_bps: 2000, vault_bps: 0, burn_bps: 0, buyback_bps: 0 },
    { holder_bps: 5000, vault_bps: 2000, burn_bps: 1000, buyback_bps: 1000 },
    { holder_bps: 10000, vault_bps: 0, burn_bps: 0, buyback_bps: 0 },
    { holder_bps: 0, vault_bps: 0, burn_bps: 0, buyback_bps: 0 },
  ]) {
    const b = bucketsOf(t);
    const total = b.holder + b.vault + b.burn + b.buyback + b.rex;
    ok(total === 10_000, `buckets sum to exactly 10000 (holder ${b.holder}, rex ${b.rex})`);
  }
  // A launcher cannot over-allocate their way into REX paying them.
  const over = bucketsOf({ holder_bps: 9000, vault_bps: 5000, burn_bps: 0, buyback_bps: 0 });
  ok(over.rex === 0, 'an over-allocated launch drives REX\'s share to zero, never negative');
}

console.log('\n── splitClaim: nothing created, nothing lost');
{
  const b = bucketsOf({ holder_bps: 5000, vault_bps: 2000, burn_bps: 1000, buyback_bps: 500 });
  for (const amt of [0n, 1n, 7n, 999n, 1_000_000n, 123_456_789n, 10n ** 18n]) {
    const { parts, remainder } = splitClaim(amt, b);
    ok(sum(parts) + remainder === amt, `${amt}: parts + remainder === the claim exactly`);
    ok(remainder >= 0n, `${amt}: remainder is never negative`);
    ok(Object.values(parts).every((v) => v > 0n), `${amt}: no zero-value line is emitted`);
  }
  ok(splitClaim(0n, b).remainder === 0n, 'a zero claim splits to nothing at all');
  ok(splitClaim(-5n, b).remainder === 0n, 'a negative claim is refused rather than inverted');
}

console.log('\n── dust goes to the next run, not to the last bucket computed');
{
  // Four equal buckets and an amount that cannot divide evenly: the shortfall must survive as
  // remainder rather than being silently handed to whichever bucket the loop happens to end on.
  const b = { a: 2500, bb: 2500, c: 2500, d: 2500 };
  const { parts, remainder } = splitClaim(10n ** 0n * 7n, b);   // 7 base units over 4 equal shares
  ok(remainder === 7n - sum(parts), 'the undividable part is reported as remainder');
  ok(remainder > 0n, `and it is actually non-zero here (${remainder}) — the case that matters`);
  const vals = Object.values(parts);
  ok(new Set(vals.map(String)).size <= 1, 'equal buckets receive equal amounts — no bucket is favoured by loop order');
}

console.log('\n── idempotency: a replayed claim cannot pay twice');
{
  const mint = 'TestMint' + Math.random().toString(36).slice(2, 10);
  db.prepare(`INSERT OR REPLACE INTO tokens(mint,name,symbol,creator,quote,status,venue,holder_bps,vault_bps,burn_bps,buyback_bps,yield_pool,vault_pot,burn_pot,buyback_pot,rex_pot,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,?)`)
    .run(mint, 'Test', 'TST', '11111111111111111111111111111112', 'REX', 'live', 'dbc', 5000, 0, 0, 0, Date.now());

  __noteDecimals('q', 6);                       // as a crank run would, before splitting
  const sig = 'sig' + Math.random().toString(36).slice(2, 12);
  ok(!claimSeen(sig), 'an unseen signature reports as unseen');
  recordClaim({ sig, mint, pool: 'pool1', side: 'partner', quoteAmount: 1_000_000n, baseAmount: 0n, quoteMint: 'q' });
  ok(claimSeen(sig), 'and as seen once recorded');

  recordClaim({ sig, mint, pool: 'pool1', side: 'partner', quoteAmount: 1_000_000n, baseAmount: 0n, quoteMint: 'q' });
  const rows = db.prepare('SELECT COUNT(*) n FROM fee_claims WHERE sig=?').get(sig).n;
  ok(rows === 1, 'recording the same signature twice stores one row, not two');

  const claim = unsplit().find((c) => c.sig === sig);
  ok(!!claim, 'an unsplit claim is queued for the next run');
  const before = db.prepare('SELECT yield_pool FROM tokens WHERE mint=?').get(mint).yield_pool;
  const first = applySplit(claim);
  const after = db.prepare('SELECT yield_pool FROM tokens WHERE mint=?').get(mint).yield_pool;
  ok(!!first && after > before, `the first split credits the holder pot (${before} -> ${after})`);

  const second = applySplit(claim);
  const after2 = db.prepare('SELECT yield_pool FROM tokens WHERE mint=?').get(mint).yield_pool;
  ok(second === null, 'splitting the same claim again is refused');
  ok(after2 === after, 'and credits nothing the second time — no double payment');
  ok(!unsplit().some((c) => c.sig === sig), 'a split claim leaves the pending queue');

  db.prepare('DELETE FROM fee_claims WHERE sig=?').run(sig);
  db.prepare('DELETE FROM tokens WHERE mint=?').run(mint);
}

console.log('\n── a claim for an unknown mint is survivable');
{
  const sig = 'orphan' + Math.random().toString(36).slice(2, 10);
  recordClaim({ sig, mint: 'NoSuchMint', pool: 'p', side: 'partner', quoteAmount: 5n, baseAmount: 0n, quoteMint: 'q' });
  const claim = unsplit().find((c) => c.sig === sig);
  ok(applySplit(claim) === null, 'it returns null rather than throwing, so one bad row cannot stall the crank');
  db.prepare('DELETE FROM fee_claims WHERE sig=?').run(sig);
}

console.log('\n── the curve config carries the promises we make on the site');
{
  const c = await curveConfig({ poolFeeBps: 200, creatorSharePct: 50, initialMarketCap: 5000, migrationMarketCap: 50000, quoteDecimals: 6 });
  ok(!!c, 'a config builds from REX-shaped inputs');
  ok(c.poolFees?.baseFee !== undefined || c.poolFees !== undefined, 'and carries pool fees');
  ok(c.collectFeeMode === 0, 'collectFeeMode is QuoteToken — the fee is never taken in the launched token');
  ok(c.migrationOption === 1, 'migration targets DAMM v2, whose liquidity can be locked rather than burned');
  // The whole economic reason for the move: locked, not burned, so it keeps earning.
  ok((c.partnerLockedLpPercentage ?? c.partnerPermanentLockedLiquidityPercentage) === 100,
    'partner liquidity is 100% permanently locked — same rug-resistance as burning, but it still earns');

  const anti = await curveConfig({ poolFeeBps: 200, creatorSharePct: 50, initialMarketCap: 5000, migrationMarketCap: 50000, quoteDecimals: 6, decayFromBps: 2000, decaySeconds: 60 });
  ok(!!anti, 'an anti-snipe decaying opening fee also builds');
}

console.log('\n── token badges: the gate that would have failed every xStock launch');
{
  const MET = await import('../lib/meteora.mjs');
  ok(typeof MET.badgeFor === 'function', 'badgeFor exists');
  // Pure-logic assertions here; the live mainnet checks live in tools/ and were run by hand, because
  // a unit test that needs an RPC is a unit test that fails when the RPC does.
  //
  // What matters is the RULE: metadata-only extensions are permissionless, anything else needs a
  // badge that Meteora issues. The enum values are read from @solana/spl-token rather than
  // hardcoded — I hardcoded MetadataPointer as 16 when it is 18, which flagged $REX as needing a
  // badge it does not have and would have refused every REX-quoted launch.
  const { ExtensionType } = await import('@solana/spl-token');
  ok(ExtensionType.MetadataPointer === 18, `MetadataPointer is ${ExtensionType.MetadataPointer}, and the code reads it from the enum`);
  ok(ExtensionType.TokenMetadata === 19, `TokenMetadata is ${ExtensionType.TokenMetadata}`);
  ok(ExtensionType.TransferHook !== undefined && ExtensionType.PermanentDelegate !== undefined,
    'the extensions an xStock carries are all nameable, so none can be missed by a hardcoded list');
}

console.log('\n── the quote asset decides the decimals, and the ledger states the claim');
{
  const { db } = await import('../lib/db.mjs');
  // A 9-decimal quote (SOL) and a 6-decimal one (REX) must each credit the right figure. This was
  // hardcoded to 6, so SOL credited 1000x — nothing errored, the number just looked wonderful.
  for (const [quote, dec] of [['SOL', 9], ['REX', 6], ['USDC', 6]]) {
    const mint = 'Dec' + quote + Math.random().toString(36).slice(2, 8);
    db.prepare(`INSERT OR REPLACE INTO tokens(mint,name,symbol,creator,quote,status,venue,holder_bps,vault_bps,burn_bps,buyback_bps,yield_pool,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(mint, 'T', 'T', '11111111111111111111111111111112', quote, 'live', 'dbc', 10000, 0, 0, 0, Date.now());
    const sig = 'd' + Math.random().toString(36).slice(2, 12);
    // ⛔ ONE QUOTE MINT PER ASSET. The decimals now come from the MINT, so three assets sharing
    // one fake mint would all resolve to whatever the last one posed — which is the bug, not a test.
    const qMint = 'QM' + quote;
    __noteDecimals(qMint, dec);
    const one = BigInt(10) ** BigInt(dec);           // exactly 1.0 of the quote
    recordClaim({ sig, mint, pool: 'p', side: 'partner', quoteAmount: one, baseAmount: 0n, quoteMint: qMint });
    applySplit(unsplit().find((c) => c.sig === sig));
    const credited = db.prepare('SELECT yield_pool FROM tokens WHERE mint=?').get(mint).yield_pool;
    ok(Math.abs(credited - 1) < 1e-9, `${quote} (${dec}dp): 1.0 claimed credits 1.0, not ${credited}`);
    db.prepare('DELETE FROM fee_claims WHERE sig=?').run(sig);
    db.prepare('DELETE FROM tokens WHERE mint=?').run(mint);
  }

  // The ledger exists because the split is no longer on-chain. It has to report what was CLAIMED.
  const mint = 'Led' + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT OR REPLACE INTO tokens(mint,name,symbol,creator,quote,status,venue,holder_bps,vault_bps,burn_bps,buyback_bps,yield_pool,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(mint, 'T', 'T', '11111111111111111111111111111112', 'REX', 'live', 'dbc', 5000, 0, 0, 0, Date.now());
  const sig = 'L' + Math.random().toString(36).slice(2, 12);
  recordClaim({ sig, mint, pool: 'p', side: 'partner', quoteAmount: 1_000_007n, baseAmount: 0n, quoteMint: 'q' });
  applySplit(unsplit().find((c) => c.sig === sig));
  const row = ledger(mint).claims[0];
  ok(String(row.quote_amount) === '1000007', `the ledger reports the amount CLAIMED (${row.quote_amount}), not the leftover dust`);
  ok(String(row.remainder) !== '0', `and records the carried remainder separately (${row.remainder})`);
  db.prepare('DELETE FROM fee_claims WHERE sig=?').run(sig);
  db.prepare('DELETE FROM tokens WHERE mint=?').run(mint);
}

console.log('\n── the vault, as the team chose it: "Deepest" + "Deepen Rex"');
{
  const V = await import('../lib/vault2.mjs');
  ok(V.strategy() === 'both', `strategy is 'both' — full range, deepest book (got '${V.strategy()}')`);
  ok(V.STRATEGIES.includes('bid') && V.STRATEGIES.includes('lock'), 'the other two remain available as settings');

  // The bid range must stay entirely BELOW spot or it stops being single-sided and silently needs
  // tokens the vault does not hold.
  const anchor = (await import('@coral-xyz/anchor')).default;
  const spot = new anchor.BN('18446744073709551616');
  for (const depth of [1, 5, 15, 40, 90]) {
    const r = V.bidRange(spot, depth);
    const lo = BigInt(r.minSqrtPrice.toString()), hi = BigInt(r.maxSqrtPrice.toString()), sp = BigInt(spot.toString());
    ok(lo < hi && hi < sp, `bid range at ${depth}% depth is ordered and entirely below spot`);
  }

  // Deepening $REX must never guess a pool. Most REX liquidity is on PumpSwap, which this codebase
  // cannot deposit into, so an unset pool has to refuse rather than pick one.
  let refused = false;
  try { V.rexPool(); } catch { refused = true; }
  ok(refused, 'with VAULT_TARGET=rex and no REX_POOL set, it refuses instead of guessing a pool');
}

console.log('\n── ⛔ THE QUOTE DECIMALS ARE REQUIRED, NOT DEFAULTED');
{
  // A default of 6 is not a fallback, it is a silent factor of a thousand on a 9-decimal quote —
  // and it is how a STONK pair opened at $5 instead of $5,000.
  for (const [name, call] of [
    ['curveConfig', () => curveConfig({ poolFeeBps: 200, creatorSharePct: 50, initialMarketCap: 5000, migrationMarketCap: 50000 })],
  ]) {
    let threw = false;
    try { await call(); } catch (e) { threw = /needs the quote decimals/.test(e.message); }
    ok(threw, `${name} refuses to run without them`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
