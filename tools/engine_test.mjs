// Deterministic engine checks against a scratch DB. Run: npm test
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/forge-test-' + process.pid;
process.env.CONVICTION_SCALE = '1';
const E = await import('../lib/engine.mjs');
const { cfg: cfgE } = await import('../lib/config.mjs');
const { db } = await import('../lib/db.mjs');
const assert = (c, m) => { if (!c) { console.error('❌', m); process.exitCode = 1; } else console.log('✅', m); };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const A = 'A'.repeat(0) + '11111111111111111111111111111111111111111A', B = '11111111111111111111111111111111111111111B', C = '11111111111111111111111111111111111111111C';
for (const w of [A, B, C]) { E.ensureWallet(w); E.credit(w, 'SOL', 1000); }

// 1. curve sizing: 85 SOL raise sells exactly 793.1M tokens and lands the AMM on the same price
const t = E.createToken(A, { name: 'Test Coin', symbol: 'TEST', quote: 'SOL', holderBps: 300, fairOpenSecs: 0 });
const t0 = E.getToken.get(t.mint);
assert(near(t0.v_quote, 30) && near(t0.raise_target, E.RAISE_SOL) && near(E.RAISE_SOL, 85, 1e-3), `SOL curve sized 30 virtual / ${E.RAISE_SOL.toFixed(4)} raise`);
const pAll = E.previewBuy(t0, 1000);
assert(pAll.graduates && near(pAll.tokensOut, 793_100_000, 1e-9), 'buying the whole curve returns exactly 793.1M tokens');
assert(near(pAll.net, E.RAISE_SOL, 1e-9), `net quote to clear the curve = raise target (got ${pAll.net.toFixed(6)})`);
assert(near(pAll.refund, 1000 - E.RAISE_SOL / 0.97, 1e-9), 'excess over the curve is refunded');

// 2. buy/sell round trip loses exactly fees+tax
const balB0 = E.balanceOf(B, 'SOL');
const b = E.buy(B, t.mint, 10);
const tb = E.getToken.get(t.mint);
assert(near(tb.real_quote, 9.7, 1e-9), 'real reserves = net of the 3% split, and nothing else — there is no platform fee');
// REX's protocol fee is carved OUT of the 3% holder allocation, whatever rate this launch opened
// at — a creator holding $REX opens lower, and that difference goes to holders, not to them.
const rexRate = tb.rex_bps / 10_000;
assert(near(tb.rex_pot, 10 * rexRate, 1e-9) && near(tb.yield_pool, 10 * (0.03 - rexRate), 1e-9),
  `REX's ${(tb.rex_bps / 100).toFixed(2)}% came out of the holder allocation, not on top of it`);
assert(near(tb.yield_pool + tb.rex_pot, 0.3, 1e-9) && near(tb.creator_pot + tb.vault_pot + tb.burn_pot, 0), 'the four buckets sum to exactly the fee charged');
const s = E.sell(B, t.mint, b.tokensOut);
const ts = E.getToken.get(t.mint);
assert(near(ts.real_quote, 0, 1e-6) && near(ts.real_tokens, 793_100_000, 1e-9), 'full round trip restores the curve');
assert(near(s.quoteOut, 9.7 * 0.97, 1e-9), 'sell nets gross minus the same 3%');
assert(near(E.balanceOf(B, 'SOL'), balB0 - 10 + 9.7 * 0.97, 1e-9), 'wallet ledger balanced');

// 3. graduation is price-continuous
E.buy(C, t.mint, 200);
const tg = E.getToken.get(t.mint);
assert(tg.status === 'graduated', 'curve graduates when the raise is filled');
const curveEndPrice = (30 + E.RAISE_SOL) / (1_073_000_000 - 793_100_000);
assert(near(tg.amm_quote / tg.amm_tokens, curveEndPrice, 1e-9), `AMM opens at the curve's final price (${curveEndPrice.toExponential(4)})`);
const ammBuy = E.buy(B, t.mint, 1);
assert(ammBuy.tokensOut > 0 && ammBuy.fee === 0 && ammBuy.tax > 0, 'AMM trades work after graduation, on the same split and no pool fee');

// 4. Fair Open: uniform price for everyone including the dev, pro-rata allocation
const f = E.createToken(A, { name: 'Fair Coin', symbol: 'FAIR', quote: 'SOL', holderBps: 100, fairOpenSecs: 60, devBuy: 5 });
E.placeBid(B, f.mint, 1); E.placeBid(C, f.mint, 4); E.placeBid(B, f.mint, 1);
const tfBefore = E.getToken.get(f.mint);
assert(tfBefore.status === 'fairopen' && near(tfBefore.fair_open_total, 11), 'bids escrowed (dev 5 + B 2 + C 4 = 11)');
db.prepare('UPDATE tokens SET fair_open_ends=? WHERE mint=?').run(Date.now() - 1, f.mint);
assert(E.settleDue() === 1, 'settleDue settles the expired window');
const fills = E.tradesOf(f.mint);
const prices = new Set(fills.map((x) => x.price.toFixed(15)));
assert(fills.length === 3 && prices.size === 1, `all ${fills.length} fills at ONE uniform price (${[...prices][0]})`);
const hA = E.holdingOf(A, f.mint).amount, hB = E.holdingOf(B, f.mint).amount, hC = E.holdingOf(C, f.mint).amount;
assert(near(hA / hB, 2.5, 1e-9) && near(hC / hB, 2, 1e-9), 'allocation is exactly pro-rata to committed quote');
const lone = E.previewBuy({ ...E.curveInit('SOL'), status: 'live', holder_bps: 100 }, 5);
assert(hA < lone.tokensOut, 'dev gets FEWER tokens than a block-0 snipe would (no first-mover edge)');

// 5. Reward epoch. There are TWO modes and the launcher picks; these assertions used to pin the
//    balance-only rule as the single invariant, which stopped being true on 3 Oct when Diamond Hands
//    became the default. Both rules are checked here instead of one.
db.prepare('UPDATE holdings SET held_since=? WHERE wallet=? AND mint=?').run(Date.now() - 80 * 3_600_000, C, f.mint); // 80 h -> 3.0x
db.prepare('UPDATE holdings SET held_since=? WHERE wallet=? AND mint=?').run(Date.now() - 2 * 3_600_000, B, f.mint);  // 2 h  -> 1.25x
db.prepare('UPDATE tokens SET yield_pool=10 WHERE mint=?').run(f.mint);

// 5a. 'flat' — balance alone, exactly as before.
db.prepare("UPDATE tokens SET reward_mode='flat' WHERE mint=?").run(f.mint);
const tokBefore = E.getToken.get(f.mint);
const res = E.runEpoch().find((r) => r.mint === f.mint);
const by = Object.fromEntries(res.payouts.map((p) => [p.wallet, p]));
const W = hA + hB + hC;
const opsCut = 10 * (cfgE.opsBps || 0) / 10_000;
const holderPot = 10 - opsCut;
assert(near(by[C].amount, holderPot * hC / W, 1e-9), "'flat': an 80-hour holder is paid strictly pro-rata to balance");
assert(near(by[A].amount, holderPot * hA / W, 1e-9), "'flat': a fresh holder of the same size is paid the same");
assert(near(by[C].amount / by[A].amount, hC / hA, 1e-9), "'flat': the only thing that sets a share is balance — hold time buys nothing");

// 5b. 'hold' (Diamond Hands, the default) — balance x conviction. Same balances, same pot, and the
//     80-hour holder must now out-earn the fresh wallet by exactly the multiplier ratio.
{
  // reward_mode only — the pool is passed to rewardSnapshot as an argument, and writing yield_pool
  // here would refill a pot the epoch above has already drained and break the accounting check below.
  db.prepare("UPDATE tokens SET reward_mode='hold' WHERE mint=?").run(f.mint);
  const snap = E.rewardSnapshot(f.mint, 10);
  const sh = Object.fromEntries(snap.eligible.map((x) => [x.wallet, x.share]));
  const multC = E.convictionOf(Date.now() - 80 * 3_600_000).mult;
  const multA = E.convictionOf(Date.now()).mult;
  assert(near(sh[C] / sh[A], (hC * multC) / (hA * multA), 1e-6),
    `'hold': an 80-hour holder's share is balance x conviction (${multC}x vs ${multA}x)`);
  assert(sh[C] / sh[A] > hC / hA, "'hold': and therefore strictly more than balance alone would give");
  assert(near(Object.values(sh).reduce((a, b) => a + b, 0), 1, 1e-9), "'hold': shares still sum to exactly 1");
  db.prepare("UPDATE tokens SET reward_mode='flat' WHERE mint=?").run(f.mint);
}
const paidOut = res.payouts.reduce((s, p) => s + p.amount, 0);
assert(near(paidOut + opsCut, 10, 1e-9) && near(E.getToken.get(f.mint).yield_pool, 0),
  `the pot is fully accounted for — ${paidOut.toFixed(6)} to holders + ${opsCut.toFixed(6)} to ops = 10`);
// "A reward transaction does not swap the launched token" — the payout is quote-side only.
const tokAfter = E.getToken.get(f.mint);
assert(near(tokAfter.v_quote, tokBefore.v_quote, 1e-12) && near(tokAfter.v_tokens, tokBefore.v_tokens, 1e-12) && near(tokAfter.price, tokBefore.price, 1e-12),
  'the reward payout left the curve untouched — it did not sell the token to fund itself');
// The $20 floor: a position under the quote equivalent of $20 is skipped and its share stays behind.
const D = '11111111111111111111111111111111111111111D';
E.ensureWallet(D); E.credit(D, 'SOL', 1000);
const small = E.createToken(A, { name: 'Floor', symbol: 'FLOOR', quote: 'SOL', holderBps: 300, fairOpenSecs: 0 });
E.buy(A, small.mint, 5); E.buy(D, small.mint, 0.0001);                       // D's stake is worth cents
db.prepare('UPDATE tokens SET yield_pool=1 WHERE mint=?').run(small.mint);
const fres = E.runEpoch().find((r) => r.mint === small.mint);
assert(!fres.payouts.some((p) => p.wallet === D) && fres.skipped >= 1, 'a holder under the $20 floor is skipped');
assert(fres.payouts.some((p) => p.wallet === A), 'a holder over the floor is still paid');
// A sell still resets the hold clock — it is a badge now, not a weight.
E.sell(C, f.mint, hC / 2);
assert(E.holdingOf(C, f.mint).held_since === 0 || E.convictionOf(E.holdingOf(C, f.mint).held_since).hours < 1, 'selling resets the hold clock');

// 5b. The fee matrix from the locked spec — these are the contract's rules, mirrored here.
const feeOk = (label, f2) => { try { E.validateFees(f2); assert(true, `${label} is legal`); } catch (e) { assert(false, `${label} must be legal — ${e.message}`); } };
const feeNo = (label, f2, re) => { try { E.validateFees(f2); assert(false, `${label} must be rejected`); } catch (e) { assert(re.test(e.message), `${label} rejected → "${e.message}"`); } };
feeOk('light 1/1/1',        { holderBps: 100, vaultBps: 100, burnBps: 100 });
feeOk('full engine 2/1/1',  { holderBps: 200, vaultBps: 100, burnBps: 100 });
feeOk('stonk lean 3/0.5/0.5', { holderBps: 300, vaultBps: 50, burnBps: 50 });
feeOk('rewards only 3/0/0', { holderBps: 300 });
feeOk('memo 1/1/1/1',       { holderBps: 100, creatorBps: 100, vaultBps: 100, burnBps: 100 });
feeOk('memo 2/1/1/0',       { holderBps: 200, creatorBps: 100, vaultBps: 100 });
feeOk('full stack 3/1/1 (5%)', { holderBps: 300, vaultBps: 100, burnBps: 100 });
feeOk('3% + 1% creator + 1% vault (5%)', { holderBps: 300, creatorBps: 100, vaultBps: 100 });
feeOk('vault at its 2% ceiling', { holderBps: 200, vaultBps: 200, burnBps: 100 });
feeNo('vault 2.5%',         { holderBps: 200, vaultBps: 250 }, /Vault ceiling is 2%/);
feeNo('6%, over the ceiling', { holderBps: 300, creatorBps: 100, vaultBps: 100, burnBps: 100 }, /over the 5% ceiling/);
feeNo('creator 1.5%',       { holderBps: 100, creatorBps: 150 }, /Creator ceiling is 1%/);
feeNo('holders 0.5%',       { holderBps: 50 },  /between 1% and 3%/);
feeNo('holders 3.5%',       { holderBps: 350 }, /between 1% and 3%/);
feeNo('quarter-point step', { holderBps: 125 }, /half-point steps/);
// A send pays zero: the engine has no transfer path that charges anything, and moving a balance
// directly leaves every pot exactly where it was.
const sendTok = E.createToken(A, { name: 'Send', symbol: 'SEND', quote: 'SOL', holderBps: 200, creatorBps: 100, vaultBps: 50, burnBps: 50, fairOpenSecs: 0 });
E.buy(B, sendTok.mint, 10);
const beforeSend = E.getToken.get(sendTok.mint);
const moved = E.holdingOf(B, sendTok.mint).amount / 2;
db.prepare('UPDATE holdings SET amount=amount-? WHERE wallet=? AND mint=?').run(moved, B, sendTok.mint);
db.prepare('INSERT INTO holdings(wallet,mint,amount,held_since,cost) VALUES(?,?,?,?,0) ON CONFLICT(wallet,mint) DO UPDATE SET amount=amount+excluded.amount').run(C, sendTok.mint, moved, Date.now());
const afterSend = E.getToken.get(sendTok.mint);
assert(['yield_pool', 'creator_pot', 'vault_pot', 'burn_pot', 'rex_pot'].every((k) => near(afterSend[k], beforeSend[k], 1e-12)),
  'a send pays zero — moving tokens charges no bucket');
// Every bucket settles in the same pass, so the pair page can post all three numbers that session.
const all = E.runEpoch().find((r) => r.mint === sendTok.mint);
const afterEpoch = E.getToken.get(sendTok.mint);
assert(all && all.creator > 0 && all.vault && all.vault.quote > 0 && all.rex && all.rex.quote > 0, 'creator, vault and REX buckets all settle in the first epoch');
assert(near(all.vault.lp / all.vault.quote, 0.7, 1e-9) && near(all.vault.bid / all.vault.quote, 0.3, 1e-9), 'the vault leg splits 70% LP / 30% quote bid');
assert(afterEpoch.vault_paid > 0 && E.balanceOf(all.vault.address, 'SOL') > 0, 'the vault address is public and funded from the first deposit');
assert(near(all.rex.burn / all.rex.quote, 0.2, 1e-9) && near(all.rex.buyback / all.rex.quote, 0.6, 1e-9) && near(all.rex.lp / all.rex.quote, 0.2, 1e-9),
  "REX's own slice splits 20% burn / 60% buyback / 20% LP");
assert(afterEpoch.burned_tokens > 0 && afterEpoch.burn_paid > 0, 'the burn leg bought the launched token with quote and destroyed it');
assert(E.FAIR_OPEN_CHOICES.join(',') === '0,60,120,300' && E.FAIR_OPEN_DEFAULT === 60, '30 seconds is gone; the default open is 60s');

// 6. adversarial edges
const throwsMsg = (fn, re, m) => { try { fn(); assert(false, m + ' (did not throw)'); } catch (e) { assert(re.test(e.message), `${m} → "${e.message}"`); } };
throwsMsg(() => E.previewBuy(E.getToken.get(f.mint), NaN), /positive/, 'NaN buy rejected');
throwsMsg(() => E.buy(B, f.mint, 1e-9), /too small/, 'dust buy rejected');
throwsMsg(() => E.placeBid(B, f.mint, 1), /closed/, 'bid on a live token rejected');
throwsMsg(() => E.cancelBid(B, f.mint), /closed/, 'cancel after the bell rejected');
const hB2 = E.holdingOf(B, f.mint).amount; const sBig = E.sell(B, f.mint, hB2 * 50);
assert(near(sBig.tokensIn, hB2, 1e-9) && E.holdingOf(B, f.mint).amount === 0, 'over-sell clamps to the holding and closes the position');
// zero-bid fair open opens cleanly
const z = E.createToken(A, { name: 'Zero Bids', symbol: 'ZERO', quote: 'USDC', holderBps: 100, fairOpenSecs: 60 });
db.prepare('UPDATE tokens SET fair_open_ends=? WHERE mint=?').run(Date.now() - 1, z.mint); E.settleDue();
const tz = E.getToken.get(z.mint); assert(tz.status === 'live' && tz.trades === 0 && near(tz.v_quote, E.curveInit('USDC').v_quote), 'zero-bid Fair Open opens live at the initial price');
// exact-graduation buy leaves the AMM consistent and the buyer with no dust refund
const g = E.createToken(A, { name: 'Exact', symbol: 'EXACT', quote: 'SOL', holderBps: 100, fairOpenSecs: 0 });
// The 1% holder bucket is the entire fee, so this is the exact gross that clears the curve.
const tg0 = E.getToken.get(g.mint); const exact = E.buy(C, g.mint, tg0.raise_target / 0.99);
const tg1 = E.getToken.get(g.mint);
assert(tg1.status === 'graduated' && Math.abs(exact.refund) < 1e-6 && near(tg1.amm_tokens, E.LP_TOKENS, 1e-9), 'exact-raise buy graduates with ~0 refund and 206.9M in the AMM');
// AMM cannot be drained below zero by a whale dumping everything
const dump = E.sell(C, g.mint, E.holdingOf(C, g.mint).amount);
const tg2 = E.getToken.get(g.mint); assert(tg2.amm_quote > 0 && tg2.amm_tokens > 0 && dump.quoteOut < tg1.amm_quote, 'whale dump leaves positive AMM reserves');
// constant product holds through a random trade storm
const k0 = E.getToken.get(z.mint).k; for (let i = 0; i < 300; i++) { const w = [A, B, C][i % 3]; try { if (Math.random() < 0.6) E.buy(w, z.mint, 1 + Math.random() * 300); else E.sell(w, z.mint, E.holdingOf(w, z.mint).amount * Math.random()); } catch {} }
const tk = E.getToken.get(z.mint); assert(tk.status === 'graduated' || near(tk.v_quote * tk.v_tokens, k0, 1e-9), `virtual constant product holds after 300 random trades (k drift ${Math.abs(tk.v_quote * tk.v_tokens / k0 - 1).toExponential(2)})`);
assert(tk.status === 'graduated' || near(tk.real_quote, tk.v_quote - E.curveInit('USDC').v_quote, 1e-9), 'real reserves track virtual reserves exactly');
assert(tk.real_quote >= -1e-9 && tk.real_tokens >= -1e-9, 'reserves never go negative');
// buying more does NOT reset the hold clock; only selling does
const hs = Date.now() - 10 * 3_600_000; db.prepare('UPDATE holdings SET held_since=? WHERE wallet=? AND mint=?').run(hs, C, f.mint);
E.buy(C, f.mint, 1); assert(E.holdingOf(C, f.mint).held_since === hs, 'adding to a position keeps held_since');
// epoch with no eligible holders leaves the pool intact
const e0 = E.createToken(A, { name: 'Empty', symbol: 'EMPTY', quote: 'SOL', holderBps: 300, fairOpenSecs: 0 });
db.prepare('UPDATE tokens SET yield_pool=5 WHERE mint=?').run(e0.mint); E.runEpoch();
assert(near(E.getToken.get(e0.mint).yield_pool, 5), 'pool rolls forward when nobody holds');
console.log(process.exitCode ? '\nFAILED' : '\nALL ENGINE CHECKS PASS (incl. edges)');
