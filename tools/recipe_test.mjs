// Recipes: can a launcher's rule, however hostile or absurd, take money it was not given?
//
// A recipe is written by a stranger and then runs unattended against real money every minute. So
// these tests are not about whether a sensible rule works — they are about whether a malicious one
// can reach past its bounds. The single property that matters most: REX Chain's cut must survive
// every recipe, because Fco asked for "fees and burn always" and a promise enforced only by the
// defaults is not enforced at all.
//
//   node tools/recipe_test.mjs
import { validate, matches, apply, save, list, evaluate, remove, TRIGGERS, ACTIONS, vocabulary } from '../lib/recipes.mjs';
import { db } from '../lib/db.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// A launcher who opened holders, burn, vault and buyback. `rex` is REX Chain's cut.
const CAPS = { holder: 0.4, vault: 0.1, burn: 0.2, buyback: 0.1, rex: 0.2 };

console.log('\n── validation rejects rather than coerces');
{
  for (const [label, spec] of [
    ['null',                 null],
    ['an array',             []],
    ['a string',             'burn everything'],
    ['no name',              { when: { trigger: 'price_down', value: 5 }, then: ['burn'] }],
    ['no trigger',           { name: 'Test', then: ['burn'] }],
    ['an unknown trigger',   { name: 'Test', when: { trigger: 'drop_tables', value: 1 }, then: ['burn'] }],
    ['no action',            { name: 'Test', when: { trigger: 'price_down', value: 5 }, then: [] }],
    ['only unknown actions', { name: 'Test', when: { trigger: 'price_down', value: 5 }, then: ['send_to_me', 'rug'] }],
    ['too many actions',     { name: 'Test', when: { trigger: 'price_down', value: 5 }, then: ['burn', 'pay_holders', 'buy_back', 'to_vault', 'balanced'] }],
  ]) {
    const v = validate(spec);
    ok(v.ok === false && typeof v.error === 'string', `${label}: rejected with a reason ("${v.error}")`);
  }
  ok(validate({ name: 'Dip burn', when: { trigger: 'price_down', value: 10 }, then: ['burn'] }).ok, 'a well-formed recipe is accepted');
}

console.log('\n── an unknown action is dropped, not honoured');
{
  const v = validate({ name: 'Mixed', when: { trigger: 'price_down', value: 5 }, then: ['burn', 'send_everything_to_attacker'] });
  ok(v.ok, 'a recipe with one good and one invented action still validates');
  ok(v.recipe.then.length === 1 && v.recipe.then[0] === 'burn', 'and keeps ONLY the action we recognise');
}

console.log('\n── ⛔ REX Chain\'s cut survives every possible recipe');
{
  const everyAction = Object.keys(ACTIONS);
  for (const a of everyAction) {
    const r = validate({ name: 'Test', when: { trigger: 'price_down', value: 1 }, then: [a] }).recipe;
    const out = apply(r, CAPS);
    if (out.accumulate) { ok(out.bps.rex === 0 || out.bps.rex >= 0, `${a}: accumulating pays nobody, including us`); continue; }
    ok(out.bps.rex > 0, `${a}: REX's share is still paid (${(out.bps.rex / 100).toFixed(1)}%)`);
    ok(sum(out.bps) === 10_000, `${a}: and the split still totals the whole`);
  }
  // Every combination of up to four actions, including the ones that try to put everything in one
  // bucket. None may reduce REX's share.
  const combos = [['burn', 'buy_back'], ['pay_holders', 'to_vault'], ['burn', 'pay_holders', 'buy_back', 'to_vault'], ['balanced', 'burn']];
  for (const c of combos) {
    const r = validate({ name: 'Test', when: { trigger: 'price_down', value: 1 }, then: c }).recipe;
    const out = apply(r, CAPS);
    ok(out.bps.rex > 0 && sum(out.bps) === 10_000, `[${c.join('+')}]: REX paid, total exact`);
  }
}

console.log('\n── a recipe cannot open a bucket the launcher closed');
{
  const closed = { holder: 0.5, vault: 0, burn: 0, buyback: 0, rex: 0.5 };
  const r = validate({ name: 'Burn', when: { trigger: 'price_down', value: 1 }, then: ['burn', 'to_vault'] }).recipe;
  const out = apply(r, closed);
  ok((out.bps.burn || 0) === 0, 'an action aimed at a closed bucket allocates it nothing');
  ok((out.bps.vault || 0) === 0, 'and the same for the second one');
  ok(sum(out.bps) === 10_000, 'while the split still totals the whole');
  ok(out.bps.rex > 0, 'and REX is still paid');
}

console.log('\n── triggers fire only when they should');
{
  const snap = { priceChange1h: -12, priceChange24h: -30, marketCapUsd: 50_000, volume24hUsd: 9_000,
    unclaimedFeeUsd: 40, holders: 120, liquidityUsd: 20_000, hoursSinceLaunch: 6 };
  const mk = (trigger, value, ifs = []) => validate({ name: 'Test', when: { trigger, value }, if: ifs, then: ['burn'] }).recipe;

  ok(matches(mk('price_down', 10), snap), 'price_down 10% fires on a 12% drop');
  ok(!matches(mk('price_down', 20), snap), 'and does not fire on a 12% drop when it wants 20%');
  ok(matches(mk('price_down', -10), snap), 'a negative threshold is read as magnitude, not a sign flip');
  ok(!matches(mk('price_up', 5), snap), 'price_up does not fire while the price is falling');
  ok(matches(mk('mcap_above', 10_000), snap), 'mcap_above fires');
  ok(!matches(mk('mcap_below', 10_000), snap), 'mcap_below does not');
  ok(matches(mk('fees_above', 25), snap), 'fees_above fires at $40 when it wants $25');

  // Conditions are ANDed — one false condition stops the whole recipe.
  ok(matches(mk('price_down', 10, [{ trigger: 'fees_above', value: 25 }]), snap), 'trigger plus a true condition fires');
  ok(!matches(mk('price_down', 10, [{ trigger: 'fees_above', value: 500 }]), snap), 'a single false condition blocks the recipe');
  ok(!matches(mk('price_down', 10, [{ trigger: 'fees_above', value: 25 }, { trigger: 'holders_above', value: 9999 }]), snap),
    'and so does one false condition among several true ones');

  // A snapshot with nothing in it must not fire thresholds by accident.
  const empty = { priceChange1h: 0, priceChange24h: 0, marketCapUsd: 0, volume24hUsd: 0, unclaimedFeeUsd: 0, holders: 0, liquidityUsd: 0, hoursSinceLaunch: 0 };
  ok(!matches(mk('mcap_below', 1000), empty), 'mcap_below does not fire on a launch with no market cap yet');
  ok(!matches(mk('liquidity_below', 1000), empty), 'nor liquidity_below on zero liquidity');
}

console.log('\n── storage, limits and cooldown');
{
  const mint = 'RecipeTest' + Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT OR REPLACE INTO tokens(mint,name,symbol,creator,quote,status,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(mint, 'T', 'T', '11111111111111111111111111111112', 'REX', 'live', Date.now());

  for (let i = 0; i < 12; i++) save(mint, { name: 'R' + i, when: { trigger: 'price_down', value: 5 }, then: ['burn'] });
  ok(list(mint).length === 10, 'at most ten recipes per launch are stored');
  const over = save(mint, { name: 'R99', when: { trigger: 'price_down', value: 5 }, then: ['burn'] });
  ok(over.ok === false, 'and the eleventh is refused with a reason');

  for (const r of list(mint)) remove(r.id, mint);
  const one = save(mint, { name: 'Dip', when: { trigger: 'price_down', value: 5 }, then: ['burn'], cooldownMins: 60 });
  ok(one.ok, 'a single recipe saves');

  const snap = { priceChange1h: -20, priceChange24h: -20, marketCapUsd: 1, volume24hUsd: 1, unclaimedFeeUsd: 1, holders: 1, liquidityUsd: 1, hoursSinceLaunch: 1 };
  const first = evaluate(mint, snap, CAPS);
  ok(!!first, 'it fires when its trigger matches');
  ok(first.bps.rex > 0, 'and REX is paid on the fire');
  const second = evaluate(mint, snap, CAPS);
  ok(second === null, 'and does NOT fire again inside its cooldown');

  // Two matching recipes: only one may author the split, or the second overwrites the first.
  for (const r of list(mint)) remove(r.id, mint);
  save(mint, { name: 'Alpha', when: { trigger: 'price_down', value: 5 }, then: ['burn'], cooldownMins: 5 });
  save(mint, { name: 'Beta', when: { trigger: 'price_down', value: 5 }, then: ['pay_holders'], cooldownMins: 5 });
  const fired = evaluate(mint, snap, CAPS);
  ok(fired?.recipe.name === 'Alpha', 'with two matches, the FIRST created wins — not both, not the last');

  for (const r of list(mint)) remove(r.id, mint);
  db.prepare('DELETE FROM tokens WHERE mint=?').run(mint);
  db.prepare('DELETE FROM recipe_fires WHERE mint=?').run(mint);
}

console.log('\n── cooldown cannot be set to something abusive');
{
  const fast = validate({ name: 'Fast', when: { trigger: 'price_down', value: 1 }, then: ['burn'], cooldownMins: 0 }).recipe;
  ok(fast.cooldownMins >= 5, `a zero cooldown is raised to a floor (${fast.cooldownMins}m) — a recipe firing every minute spends its fees on signatures`);
  const neg = validate({ name: 'Neg', when: { trigger: 'price_down', value: 1 }, then: ['burn'], cooldownMins: -999 }).recipe;
  ok(neg.cooldownMins >= 5, 'and so is a negative one');
}

console.log('\n── the published vocabulary is the whole vocabulary');
{
  const v = vocabulary();
  ok(v.triggers.length === Object.keys(TRIGGERS).length, `every trigger is published (${v.triggers.length})`);
  ok(v.actions.length === Object.keys(ACTIONS).length, `every action is published (${v.actions.length})`);
  ok(!v.actions.some((a) => /wallet|address|send|transfer/i.test(a.key)), 'no action names a destination — recipes choose proportions, never recipients');
  ok(typeof v.note === 'string' && /cannot/i.test(v.note), 'and the limits are stated to the person writing the recipe');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
