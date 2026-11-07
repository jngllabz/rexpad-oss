// The two holder-reward modes, and the invariants that must hold in BOTH.
//
// Elio's call, 3 Oct: both ship, the launcher picks, the default is Diamond Hands. This decides who
// gets paid what out of a real pot, so the properties below are the ones worth pinning down — above
// all the ones that are easy to get subtly wrong and impossible to notice from a UI:
//
//   · the eligibility floor must apply to BALANCE, never to the conviction-weighted figure, or the
//     multiplier quietly admits dust positions the floor exists to exclude;
//   · a wallet with no hold clock (never seen, or sold) must fall to 1.0x and still be PAID, not
//     dropped — it has a balance and the chain says so;
//   · exclusions must be honoured identically in both modes;
//   · and allocation must never pay out more than the pot.
//
//   node tools/reward_mode_test.mjs
import { proRata, allocate } from '../lib/chain.mjs';
import { rewardMode, REWARD_MODE_DEFAULT } from '../lib/engine.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const H = 3_600_000, now = Date.now();
const w = (r, o) => r.weighted.find((x) => x.owner === o);
const paid = (a, o) => a.find((x) => x.owner === o)?.amount ?? 0;

console.log('\n── the mode selector');
ok(REWARD_MODE_DEFAULT === 'hold', 'the platform default is Diamond Hands');
ok(rewardMode(undefined) === 'hold' && rewardMode(null) === 'hold', 'a missing choice becomes the default');
ok(rewardMode('flat') === 'flat', 'a launcher can choose simple');
for (const junk of ['../etc/passwd', 'HOLD', '', 0, {}, []])
  ok(rewardMode(junk) === 'hold', `junk (${JSON.stringify(junk)}) falls back to the default rather than throwing`);

console.log('\n── Elio\'s stated example: three-day holder vs fresh wallet, same size');
{
  const pos = [{ owner: 'fresh', amount: 1000, heldSince: now }, { owner: 'apex', amount: 1000, heldSince: now - 73 * H }];
  const flat = proRata(pos, { mode: 'flat', now }), hold = proRata(pos, { mode: 'hold', now });
  const fa = allocate(flat.weighted, flat.total, 4000), ha = allocate(hold.weighted, hold.total, 4000);
  ok(paid(fa, 'fresh') === paid(fa, 'apex'), 'simple pays two equal balances equally');
  ok(paid(ha, 'apex') / paid(ha, 'fresh') === 3, 'Diamond Hands pays the three-day holder exactly 3x');
  ok(paid(ha, 'apex') + paid(ha, 'fresh') <= 4000, 'and never pays out more than the pot');
}

console.log('\n── a sell resets the clock');
{
  const pos = [{ owner: 'sold', amount: 1000, heldSince: null }, { owner: 'apex', amount: 1000, heldSince: now - 73 * H }];
  const r = proRata(pos, { mode: 'hold', now });
  ok(w(r, 'sold').weight === 1000, 'a wallet with no hold clock sits at 1.0x — its balance, unmultiplied');
  ok(allocate(r.weighted, r.total, 4000).some((x) => x.owner === 'sold'), 'and is still paid, not dropped');
}

console.log('\n── the floor is a BALANCE floor in both modes');
{
  // Dust that three days of conviction would lift over the floor if the floor were applied after.
  const pos = [{ owner: 'dust', amount: 5, heldSince: now - 100 * H }, { owner: 'real', amount: 1000, heldSince: now }];
  for (const mode of ['flat', 'hold']) {
    const r = proRata(pos, { mode, now, priceUsd: 1, floorUsd: 10 });   // floor = 10 tokens
    ok(!w(r, 'dust') && r.skipped.some((x) => x.owner === 'dust'),
      `${mode}: a 5-token position stays under a 10-token floor even at 3.0x conviction`);
  }
}

console.log('\n── exclusions, zero and empty');
{
  const pos = [{ owner: 'vault', amount: 9e9, heldSince: now - 500 * H }, { owner: 'holder', amount: 100, heldSince: now }];
  for (const mode of ['flat', 'hold']) {
    const r = proRata(pos, { mode, now, exclude: new Set(['vault']) });
    ok(!w(r, 'vault'), `${mode}: an excluded vault earns nothing however long it has "held"`);
    ok(Math.abs(w(r, 'holder').share - 1) < 1e-9, `${mode}: the only eligible holder takes the whole share`);
  }
  for (const mode of ['flat', 'hold']) {
    const empty = proRata([], { mode, now });
    ok(empty.total === 0 && allocate(empty.weighted, empty.total, 1000).length === 0, `${mode}: no holders pays nobody, with no divide-by-zero`);
    const zero = proRata([{ owner: 'a', amount: 0, heldSince: now }], { mode, now });
    ok(zero.weighted.length === 0, `${mode}: a zero balance is not a holder`);
  }
}

console.log('\n── conservation: the pot is never exceeded, at any mix');
{
  const pos = Array.from({ length: 40 }, (_, i) => ({ owner: 'w' + i, amount: 10 + i * 7, heldSince: now - (i * 4) * H }));
  for (const mode of ['flat', 'hold']) {
    const r = proRata(pos, { mode, now });
    const a = allocate(r.weighted, r.total, 1_000_000);
    const sum = a.reduce((s, x) => s + x.amount, 0);
    ok(sum <= 1_000_000, `${mode}: 40 holders, sum ${sum} ≤ pot`);
    ok(sum > 999_900, `${mode}: and loses only floor-rounding dust (${1_000_000 - sum})`);
    ok(a.every((x) => x.amount > 0), `${mode}: nobody is allocated a zero line`);
  }
}

console.log('\n── payout rules: Whale Club, Shrimp Fund, Flat Dividend');
{
  const pos = Array.from({ length: 10 }, (_, i) => ({ owner: 'w' + i, amount: (i + 1) * 100, heldSince: now }));
  const paid = (r) => allocate(r.weighted, r.total, 10_000);

  const all = paid(proRata(pos, { mode: 'flat', now }));
  ok(all.length === 10, 'all: every eligible holder is paid');

  const whale = paid(proRata(pos, { mode: 'flat', now, payout: 'whale', payoutN: 3 }));
  ok(whale.length === 3, 'whale: only the top 3 are paid');
  ok(whale.every((x) => ['w9', 'w8', 'w7'].includes(x.owner)), 'and they are the three LARGEST, not the first three seen');

  const shrimp = paid(proRata(pos, { mode: 'flat', now, payout: 'shrimp', payoutN: 3 }));
  ok(shrimp.length === 7, 'shrimp: the top 3 are excluded and the rest are paid');
  ok(!shrimp.some((x) => ['w9', 'w8', 'w7'].includes(x.owner)), 'and no whale slips through');

  const equal = paid(proRata(pos, { mode: 'flat', now, payout: 'equal' }));
  ok(new Set(equal.map((x) => x.amount)).size === 1, 'equal: every holder receives the identical amount');
  ok(equal.length === 10, 'and nobody eligible is dropped');

  // A flat dividend must be flat even when the weighting mode would have favoured someone.
  const mixed = [{ owner: 'whale', amount: 1e6, heldSince: now - 500 * H }, { owner: 'minnow', amount: 100, heldSince: now }];
  const flatOverride = paid(proRata(mixed, { mode: 'hold', now, payout: 'equal' }));
  ok(new Set(flatOverride.map((x) => x.amount)).size === 1,
    'equal overrides Diamond Hands too — a flat dividend that still weighted by hold time would not be flat');

  // Every rule still conserves the pot.
  for (const opts of [{}, { payout: 'whale', payoutN: 3 }, { payout: 'shrimp', payoutN: 3 }, { payout: 'equal' }]) {
    const r = proRata(pos, { mode: 'hold', now, ...opts });
    const a = paid(r);
    ok(a.reduce((x, y) => x + y.amount, 0) <= 10_000, `${opts.payout || 'all'}: never pays out more than the pot`);
  }

  // The floor is applied FIRST. A rule narrows who is eligible; it must never pay somebody the
  // floor already excluded.
  const dusty = [{ owner: 'dust', amount: 1, heldSince: now }, { owner: 'real', amount: 10_000, heldSince: now }];
  for (const payout of ['all', 'shrimp', 'equal']) {
    const r = proRata(dusty, { mode: 'flat', now, priceUsd: 1, floorUsd: 100, payout, payoutN: 1 });
    ok(!r.weighted.some((x) => x.owner === 'dust'), `${payout}: a position under the floor is never admitted by a payout rule`);
  }

  // Asking for more whales than exist must not break.
  const tooMany = paid(proRata(pos, { mode: 'flat', now, payout: 'whale', payoutN: 999 }));
  ok(tooMany.length === 10, 'whale with N larger than the holder count pays everyone, rather than erroring');
  const allShrimped = proRata(pos, { mode: 'flat', now, payout: 'shrimp', payoutN: 999 });
  ok(allShrimped.weighted.length === 0 && allShrimped.total === 0, 'shrimp that excludes everybody pays nobody, with no divide-by-zero');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
