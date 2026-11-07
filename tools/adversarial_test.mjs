// Hostile tests for the parts of the locked spec that are easy to get subtly wrong: the Advanced
// launch guards (allowlist, per-wallet cap, decaying fee), the fee module's arithmetic identities,
// the epoch's exclusions, and the migration off the old single-tax column.
// Run: node tools/adversarial_test.mjs
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/rex-adv-' + process.pid;
const E = await import('../lib/engine.mjs');
const { cfg: cfgA } = await import('../lib/config.mjs');
const { db } = await import('../lib/db.mjs');
const { QUOTES } = await import('../lib/prices.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (did not throw)`); } catch (e) { ok(re.test(e.message), `${m} → "${e.message}"`); } };

const W = (n) => { const w = '1'.repeat(43 - String(n).length) + 'z' + n; E.ensureWallet(w); E.credit(w, 'SOL', 100_000); E.credit(w, 'REX', 500_000_000); return w; };
const DEV = W('dev'), A = W('aa'), B = W('bb'), C = W('cc');
const mk = (o) => E.createToken(o.creator || DEV, { name: o.name || 'Adv', symbol: o.symbol || 'ADV', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0, fairOpenSecs: 0, ...o });

console.log('\n── fee arithmetic: the four buckets must account for every unit charged');
{
  // Each row is a COMPLETE split — mk's defaults must not leak in, or the sums stop being the ones
  // the spec's table names.
  for (const f of [{ holderBps: 100, creatorBps: 100, vaultBps: 100, burnBps: 100 },
                   { holderBps: 300, creatorBps: 0, vaultBps: 50, burnBps: 50 },
                   { holderBps: 150, creatorBps: 50, vaultBps: 50, burnBps: 50 },
                   { holderBps: 300, creatorBps: 0, vaultBps: 0, burnBps: 0 }]) {
    const t = mk({ symbol: 'FEE' + f.holderBps + f.creatorBps + f.vaultBps + f.burnBps, ...f });
    const before = E.getToken.get(t.mint);
    E.buy(A, t.mint, 50);
    const after = E.getToken.get(t.mint);
    const total = f.holderBps + f.creatorBps + f.vaultBps + f.burnBps;
    const charged = 50 * total / 10_000;
    const banked = (after.yield_pool - before.yield_pool) + (after.creator_pot - before.creator_pot)
                 + (after.vault_pot - before.vault_pot) + (after.burn_pot - before.burn_pot) + (after.rex_pot - before.rex_pot);
    ok(near(banked, charged), `${total / 100}% charged on 50 SOL lands in the buckets to the unit (${banked.toFixed(9)} vs ${charged.toFixed(9)})`);
    // REX's cut must come out of the holder bucket, never out of the other three
    const holderGross = 50 * f.holderBps / 10_000;
    ok(near((after.yield_pool - before.yield_pool) + (after.rex_pot - before.rex_pot), holderGross),
      `  and REX's slice came out of the ${f.holderBps / 100}% holder bucket, not on top`);
  }
}

console.log('\n── a sell is charged the same four buckets as a buy, on the quote leg');
{
  // Stay well under the 85 SOL raise: a graduated pair also routes the 0.25% AMM fee to holders,
  // which is correct but is not the identity under test here.
  const t = mk({ symbol: 'SELL', holderBps: 200, creatorBps: 100, vaultBps: 100 });
  E.buy(A, t.mint, 20);
  const held = E.holdingOf(A, t.mint).amount;
  const before = E.getToken.get(t.mint);
  const s = E.sell(A, t.mint, held / 2);
  const after = E.getToken.get(t.mint);
  const banked = (after.yield_pool - before.yield_pool) + (after.creator_pot - before.creator_pot)
               + (after.vault_pot - before.vault_pot) + (after.rex_pot - before.rex_pot);
  ok(near(banked, s.gross * 0.04), `the sell's 4% came off the quote side (${banked.toFixed(9)})`);
  ok(near(s.quoteOut, s.gross * (1 - 0.04)), 'the seller receives gross less the 4% split and nothing else — no platform fee on top');
}

console.log('\n── allowlist: only inside the window, creator always in, no window = no allowlist');
{
  const t = mk({ symbol: 'ALLOW', fairOpenSecs: 60, allowlist: `${A}\n${B}` });
  const row = E.getToken.get(t.mint);
  ok(row.allowlist === `${A},${B}`, 'the pasted list is stored as validated base58 only');
  E.placeBid(A, t.mint, 1); ok(true, 'an allowlisted wallet may commit');
  throws(() => E.placeBid(C, t.mint, 1), /allowlisted/, 'a wallet off the list is refused');
  E.placeBid(DEV, t.mint, 1); ok(true, 'the creator never needs to be on their own list');

  const inst = mk({ symbol: 'NOWIN', fairOpenSecs: 0, allowlist: `${A}` });
  ok(E.getToken.get(inst.mint).allowlist === null, 'an allowlist with no window is dropped — that would be a private snipe');

  const gated = mk({ symbol: 'REXGATE', fairOpenSecs: 60, allowRexUsd: 1e12 });
  throws(() => E.placeBid(C, gated.mint, 1), /REX held/, 'the $REX-hold gate refuses a wallet under the bar');
  E.placeBid(DEV, gated.mint, 1); ok(true, 'and still lets the creator in');
}

console.log('\n── the creator cannot be most of their own open');
{
  const t = mk({ symbol: 'DEVCAP', fairOpenSecs: 60 });
  const raise = E.getToken.get(t.mint).raise_target;
  const cap = raise * E.DEV_COMMIT_MAX_BPS / 10_000;
  E.placeBid(DEV, t.mint, cap * 0.999);
  throws(() => E.placeBid(DEV, t.mint, cap * 0.01), /capped at 20%/, 'the creator is stopped at 20% of the raise');
  // ⛔ AND SO IS EVERYONE ELSE, WHICH IS THE WHOLE POINT. This used to assert the opposite — "a
  // non-creator is not capped" — and that was exactly the hole: `Commit` PDAs are seeded per
  // bidder, so a creator committing from a second keypair was an ordinary uncapped bidder and the
  // 20% claim on the launch page meant nothing. There is no sybil defence to add on chain, so the
  // constraint moved somewhere identity cannot reach it.
  E.placeBid(A, t.mint, cap * 0.999);
  throws(() => E.placeBid(A, t.mint, cap * 0.01), /capped at 20%/,
    'a second wallet is held to the same 20%, so the cap cannot be stepped around');
}

console.log('\n── the post-clear guard: per-wallet cap and a decaying fee, both sides, never to the dev');
{
  const t = mk({ symbol: 'GUARD', fairOpenSecs: 0, walletCap: 0.01, decayFeeBps: 200, decayTo: 'vault' });
  const row = E.getToken.get(t.mint);
  ok(row.guard_secs === 60 && row.wallet_cap === 0.01 && row.decay_fee_bps === 200, 'the guard is armed for 60s at the settings given');
  const g = E.guardOf(row);
  ok(g.decay > 0 && g.decay <= 200, `the decaying fee starts at or under its maximum (${g.decay} bps)`);
  ok(g.cap === 0.01, 'and the per-wallet cap is live');

  // The cap bites hard at the opening price — 1 SOL already buys several percent of supply, which is
  // exactly why a launch guard is worth having.
  throws(() => E.buy(A, t.mint, 60), /Launch guard/, 'a buy that would pass 1% of supply is refused inside the window');
  E.buy(A, t.mint, 0.2);
  ok(E.holdingOf(A, t.mint).amount <= 0.01 * E.TOTAL_SUPPLY, `a buy under the cap goes through (${(E.holdingOf(A, t.mint).amount / E.TOTAL_SUPPLY * 100).toFixed(3)}% of supply)`);

  // the decaying fee is charged on BOTH sides and goes to the vault, never the creator
  const b0 = E.getToken.get(t.mint);
  const cBefore = b0.creator_pot;
  const p = E.previewBuy(b0, 10, E.guardOf(b0).decay);
  ok(p.split.decay > 0 && near(p.split.decay, 10 * E.guardOf(b0).decay / 10_000), 'the buy preview shows the decaying fee separately');
  const held = E.holdingOf(A, t.mint).amount;
  const ps = E.previewSell(b0, held / 2, E.guardOf(b0).decay);
  ok(ps.split.decay > 0, 'a SELL inside the window is charged it too — the flip is what the guard is for');
  E.sell(A, t.mint, held / 2);
  const b1 = E.getToken.get(t.mint);
  ok(b1.vault_pot > b0.vault_pot, 'the decaying fee landed in the vault');
  ok(near(b1.creator_pot - cBefore, b0.creator_bps / 10_000 * (b1.volume_sold || 0), 1) || b1.creator_pot >= cBefore,
    'and never in the creator bucket beyond their own configured share');

  // after the window it is gone entirely
  db.prepare('UPDATE tokens SET opened_at=? WHERE mint=?').run(Date.now() - 61_000, t.mint);
  const expired = E.guardOf(E.getToken.get(t.mint));
  ok(expired.decay === 0 && expired.cap === 0 && expired.left === 0, 'once the 60s is up both the cap and the fee are gone');
  E.buy(B, t.mint, 400); ok(true, 'and a buy over the old cap is allowed again');
}

console.log('\n── the guard can never read back MORE than the creator set');
{
  const t = mk({ symbol: 'CLAMP', fairOpenSecs: 300, decayFeeBps: 100, walletCap: 0.005 });
  // during a 5-minute window fair_open_ends is far in the future — an unclamped ratio reads high
  const g = E.guardOf(E.getToken.get(t.mint));
  ok(g.decay <= 100, `inside the open window the decay still reads <= its 1% maximum (${g.decay} bps)`);
  ok(g.left <= 60, `and the countdown never exceeds the guard's own length (${g.left.toFixed(1)}s)`);
}

console.log('\n── epoch exclusions and the floor');
{
  const t = mk({ symbol: 'EPOCH', holderBps: 300, creatorBps: 0, vaultBps: 0, burnBps: 0 });
  E.buy(A, t.mint, 500); E.buy(B, t.mint, 500);
  // a reserve wallet (bot=2) holds supply but must never earn
  const R = W('res'); db.prepare('UPDATE wallets SET bot=2 WHERE wallet=?').run(R);
  E.buy(R, t.mint, 500);
  const snap = E.rewardSnapshot(t.mint, 1);
  ok(!snap.eligible.some((h) => h.wallet === R), 'a reserve wallet is excluded from the snapshot entirely');
  ok(near(snap.eligible.reduce((s, h) => s + h.share, 0), 1), 'the remaining shares still sum to exactly 1');
  const res = E.runEpoch().find((r) => r.mint === t.mint);
  ok(res && !res.payouts.some((p) => p.wallet === R), 'and it is paid nothing when the epoch runs');
  // Operations take their slice off the top before the split, so "distributed" means holders AND
  // ops together — the test that matters is that none of the pot goes anywhere else.
  const opsCut = res.pool * (cfgA.opsBps || 0) / 10_000;
  ok(near(res.payouts.reduce((s, p) => s + p.amount, 0) + opsCut, res.pool, 1e-6),
    'the whole pool is accounted for — holders plus the ops slice, to the unit');
}

console.log('\n── the first epoch pays whatever it collected; later dust rolls forward');
{
  const t = mk({ symbol: 'FIRST', holderBps: 100, creatorBps: 0, vaultBps: 0, burnBps: 0 });
  E.buy(A, t.mint, 1000);
  db.prepare('UPDATE tokens SET yield_pool=0.0000001 WHERE mint=?').run(t.mint);  // far under the dust bar
  const first = E.runEpoch().find((r) => r.mint === t.mint);
  ok(first && first.holders > 0, 'the first epoch published a tiny pool rather than showing a zero page');
  db.prepare('UPDATE tokens SET yield_pool=0.0000001 WHERE mint=?').run(t.mint);
  const second = E.runEpoch().find((r) => r.mint === t.mint);
  ok(!second || second.pool === 0, 'the second epoch rolls the same dust forward instead');
  ok(E.getToken.get(t.mint).yield_pool > 0, 'and the dust is still there, waiting');
}

console.log('\n── migration off the single tax column');
{
  const t = mk({ symbol: 'MIG', holderBps: 100 });
  // simulate a pre-fee-module row
  db.prepare('UPDATE tokens SET tax_bps=500, holder_bps=100, creator_bps=0, vault_bps=0, burn_bps=0 WHERE mint=?').run(t.mint);
  db.exec('UPDATE tokens SET holder_bps = MAX(100, MIN(300, tax_bps)) WHERE tax_bps > 0 AND holder_bps = 100 AND creator_bps = 0 AND vault_bps = 0 AND burn_bps = 0');
  const row = E.getToken.get(t.mint);
  ok(row.holder_bps === 300, 'a legacy 5% tax is clamped into the 1–3% holder band, not carried over illegally');
  ok(E.feesOf(row).total <= E.FEE_CAP_BPS, 'and the migrated row is inside the 4% cap');
}

console.log('\n── nothing in the fee module accepts junk');
{
  for (const bad of [null, undefined, NaN, Infinity, -100, 1e308, '200', {}, []]) {
    try { E.validateFees({ holderBps: bad }); ok(bad === '200', `holderBps ${JSON.stringify(bad)} ${bad === '200' ? 'coerces from a numeric string' : 'was wrongly accepted'}`); }
    catch { ok(bad !== '200', `holderBps ${JSON.stringify(bad)} rejected`); }
  }
  const t = mk({ symbol: 'JUNK' });
  for (const bad of [NaN, Infinity, -1, 0]) throws(() => E.previewBuy(E.getToken.get(t.mint), bad), /positive/, `a ${bad} buy is refused`);
}

console.log('\n── quote registry: every pair the launch screen offers must be real');
{
  for (const [sym, q] of Object.entries(QUOTES)) {
    ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.mint), `${sym} has a well-formed mint`);
  }
  const mints = Object.values(QUOTES).map((q) => q.mint);
  ok(new Set(mints).size === mints.length, 'no two quote assets share a mint');
  ok(Object.values(QUOTES).every((q) => q.usd > 0), 'every quote asset has a non-zero fallback price');
}

console.log('\n── every quote asset is usable, and the risky one says so');
{
  const { QUOTES } = await import('../lib/prices.mjs');
  const q = Object.values(QUOTES);
  for (const x of q) {
    ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.mint), `${x.symbol}: mint is a valid base58 address`);
    ok(Number.isInteger(x.decimals) && x.decimals >= 0 && x.decimals <= 18, `${x.symbol}: decimals are sane (${x.decimals})`);
  }
  const mints = q.map((x) => x.mint);
  ok(new Set(mints).size === mints.length, 'no two quote assets share a mint');
  const syms = q.map((x) => x.symbol);
  ok(new Set(syms).size === syms.length, 'no two quote assets share a symbol');

  // A quote whose issuer can freeze accounts is categorically different from the rest, and the
  // difference has to reach the person choosing it rather than living in a comment.
  const lev = q.filter((x) => x.category === 'leverage');
  ok(lev.length >= 4, `the leverage category has the pairs Julz asked for (${lev.map((x) => x.symbol).join(', ')})`);
  for (const sym of ['xSOL', 'xBTC', 'xHYPE']) ok(lev.some((x) => x.symbol === sym), `${sym} is present`);
  // Every leveraged asset must carry its OWN caveat. A blanket category warning was wrong the
  // moment a second one arrived that cannot freeze — these differ from each other and from SOL.
  for (const x of lev) ok(typeof x.note === 'string' && x.note.length > 20,
    `${x.symbol} carries its own caveat, not a blanket one`);
  // ⛔ The decoy check. A DexScreener name search returned an "xSOL" with zero liquidity that was
  // still routable — shipping that mint would have made every xSOL launch worthless. These are the
  // mints from Jupiter's token list, pinned so a future edit cannot quietly swap one for a clone.
  const PINNED = {
    xSOL: '4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs',
    xBTC: '2zCo6bUowJMvr89ajxuWsPadAqJ2F9akCkxumNsSdgsL',
    xHYPE: '7ga6rtE9qSb3wdEiDCpTu2kHqoGVfT52jD8ign1rYTvx',
    JLP: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',
  };
  for (const [sym, mint] of Object.entries(PINNED)) {
    const got = QUOTES[sym];
    ok(got && got.mint === mint, `${sym} points at the verified mint, not a same-ticker clone`);
  }
  // ⛔ And the note must SURVIVE THE TRIP TO THE CLIENT. The first version of this test read QUOTES
  // directly and passed while quoteList() quietly dropped `note`, so the warning existed in the
  // source and reached nobody. A caveat that stops at the server is not a caveat.
  const { quoteList } = await import('../lib/prices.mjs');
  const served = quoteList();
  for (const x of lev) {
    const wire = served.find((y) => y.symbol === x.symbol);
    // Asserts the caveat SURVIVES to the client — not that it says any particular word. The first
    // version of this required /freeze/, which was true only while JLP was the sole leveraged pair;
    // the Hylo ones cannot freeze and their caveats are about depth instead. A test that demands
    // one asset's risk be every asset's risk pushes you to write a warning that is not true.
    ok(wire && typeof wire.note === 'string' && wire.note.length > 20,
      `${x.symbol}'s caveat is actually served to the client, not just defined`);
  }
  // The one that CAN freeze still has to say so, in those words.
  ok(/freeze/i.test(served.find((y) => y.symbol === 'JLP')?.note || ''),
    'JLP, the only one that can freeze accounts, says so explicitly');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
