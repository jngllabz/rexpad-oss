// Guards in the on-chain program that nothing else asserts, read from its source.
//
// ⛔ THE RUST UNIT TESTS COVER THE PURE MATHS; THESE LIVE IN INSTRUCTION HANDLERS. A `require!` in
// an Anchor handler needs a validator and a funded pool to exercise, which this repository cannot
// do in a unit test — so the next best thing is to assert the guard is still written, with the
// reason attached. Every one below was added to close a finding in the TechSlayers review of
// 2026-10-12 and would be silent and expensive to lose.
//
//   node tools/onchain_guards_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const pad = fs.readFileSync(new URL('../onchain/programs/rexpad/src/lib.rs', import.meta.url), 'utf8');
const hook = fs.readFileSync(new URL('../onchain/programs/rexhook/src/lib.rs', import.meta.url), 'utf8');
const math = fs.readFileSync(new URL('../onchain/programs/rexpad/src/math.rs', import.meta.url), 'utf8');

console.log('── REX-01: the waterfall cannot be spent while the legs disagree with the divisor');
ok(/c\.waterfall_version = 0;/.test(pad), 'raise_partner clears waterfall_version');
ok(/require!\(legs_total == denom, PadError::WaterfallMismatch\)/.test(pad),
  'distribute checks the legs sum to the divisor it is about to cut against');
ok(/require!\(paid <= pot, PadError::WaterfallMismatch\)/.test(pad),
  'and asserts it never paid out more than the bucket held');

console.log('\n── REX-02: the migration proof is narrowed to a real Raydium config');
ok(/require_keys_eq!\(\*ctx\.accounts\.amm_config\.owner, cpmm, PadError::MigrationNotProven\)/.test(pad),
  '⛔ amm_config must be owned by the CPMM program, so the caller cannot pick any pubkey as the seed');
ok(/l\.migrate_pool = pool;/.test(pad),
  '⛔ release records WHICH pool it measured, so confirm cannot be pointed at a different one');
ok(/require_keys_eq!\(pool, ctx\.accounts\.launch\.migrate_pool/.test(pad),
  '   and confirm requires that same pool');
ok(/grew_0 >= need_0/.test(pad) && /saturating_sub\(ctx\.accounts\.launch\.migrate_vault_0\)/.test(pad),
  '⛔ the proof is now the DELTA against the snapshot, not `>=` an absolute balance');
ok(!/pool_vault_0\.amount >= need_0/.test(pad),
  '   and the absolute form is gone');
// The delta, not an equality — a donation between the steps must not wedge a migration.
ok(/bare equality would let anyone wedge a migration/.test(pad),
  '   with the reason it is a delta and not `==` written down');

console.log('\n── REX-03: the commit cap does not depend on which key you use');
ok(!/if ctx\.accounts\.bidder\.key\(\) == l\.creator \{[\s\S]{0,400}?DevCommitTooLarge/.test(pad),
  '⛔ the 20% cap is no longer keyed on the creator — a second wallet was an uncapped bidder');
ok(/Any one bidder is capped at 20% of the raise/.test(
  fs.readFileSync(new URL('../onchain/programs/rexpad/src/errors.rs', import.meta.url), 'utf8')),
  '   and the error says who it applies to');

console.log('\n── REX-05 / REX-07: the pool stops absorbing the rounding');
ok(/require!\(g <= l\.real_quote as u128, PadError::InsufficientLiquidity\)/.test(math),
  '⛔ a sell the curve cannot fund reverts instead of silently capping and de-syncing k');
ok((math.match(/div_ceil\(/g) || []).length >= 5,
  `the pool's side rounds up in every path (${(math.match(/div_ceil\(/g) || []).length} uses of div_ceil)`);
ok(!/\bq - \(q \* t\) \/ \(t \+ t_in\)/.test(math) && !/\bt - \(q \* t\) \/ \(q \+ net\)/.test(math),
  '   and no floored form is left behind in the AMM paths');

console.log('\n── HOOK-01 / HOOK-02: the two that cannot be undone after the fact');
ok(/pub fn renounce[\s\S]{0,600}?require!\(!r\.frozen, HookError::Frozen\)/.test(hook),
  '⛔ renounce refuses while frozen — freeze-then-renounce bricked a mint forever');
ok(/mint\.mint_authority == COption::Some\(authority\.key\(\)\)/.test(hook),
  '⛔ only the mint\'s own authority may set up its rules, so they are not first-come-first-served');

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
