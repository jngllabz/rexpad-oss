// A pot PAST its threshold must never be described as approaching one.
//
// ⛔ WHAT WAS ACTUALLY ON THE FRONT PAGE FOR EIGHTEEN DAYS: "$278.49 in the pot · next burn fires
// at $100". Both of the panel's honest states require a LOW pot — the unverified branch needs a
// failed upstream read, and the stale branch needs the pot under a quarter of target — so the one
// case that held in real life, a pot at 2.8x target with fees still arriving daily and nothing
// burned since 23 Sept, fell through to the sentence that promises a trigger. Elio screenshotted
// it twice; Julz read the whole burn section as broken. The figures were right every time. The
// threshold was never what the burn was waiting on: rex-rewards' scheduler has `mode: manual` and
// `paused: true` on its live volume, so `scheduledRun()` returns on its first line and every burn
// there has ever been came from an admin pressing Run.
//
// This evaluates the REAL branch out of public/pages.js rather than a copy of it, because a copy
// would have agreed with itself while the page said something else.
//
//   node tools/burn_over_target_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const src = fs.readFileSync('public/pages.js', 'utf8');

// ---- the front-page strip: pull the label expression out of drawBurn and run it ----
const OPEN = '<span>${b.potUnverified';
const a = src.indexOf(OPEN);
ok(a > 0, 'the front-page pot label is where the test expects it');
const end = src.indexOf('}</span></span>', a);
const expr = src.slice(a + '<span>${'.length, end);

const fmtUsd = (n) => '$' + Number(n).toFixed(2);
const ago = () => '18d';
const label = new Function('b', 'pot', 'target', 'over', 'stale', 'last', 'fmtUsd', 'ago',
  `return (${expr});`);
// `over` is computed by the page, so the test derives it the same way the page's own line does and
// asserts that line exists — otherwise this could pass against a page that never sets it.
ok(/const over = target > 0 && pot >= target;/.test(src), 'the page derives "over" as pot >= target');
ok((src.match(/const over = target > 0 && pot >= target;/g) || []).length === 2,
  'both the strip and the /rewards panel derive it (neither was left behind)');
const call = (b, pot, target, stale = false) =>
  label(b, pot, target, target > 0 && pot >= target, stale, { at: 1 }, fmtUsd, ago);

// The exact live numbers from the complaint.
const LIVE = { potUnverified: false, autoOn: false, potStaleMs: 7184112, potMovedAt: Date.now() };
const live = call(LIVE, 278.48875346893453, 100);
ok(!/next burn fires at/.test(live), '⛔ $278.49 against a $100 target no longer says "next burn fires at"');
ok(/waiting on a manual run/.test(live), 'it says what it is really waiting on: someone to run it');

// Same pot, once the scheduler is actually switched on.
const auto = call({ ...LIVE, autoOn: true }, 278.48875346893453, 100);
ok(/burning on the next run/.test(auto), 'with auto on, the same pot promises the next run');
ok(!/manual/.test(auto), 'and stops mentioning a manual run the moment it is no longer true');

// Exactly at the threshold is past it: a burn is due, not pending more fees.
ok(/past the threshold/.test(call(LIVE, 100, 100)), 'a pot exactly AT target counts as past it');
ok(/next burn fires at/.test(call(LIVE, 99.99, 100)), 'a cent short still shows the threshold');

// The two states that were already honest must survive untouched.
ok(/next burn fires at/.test(call(LIVE, 5.61, 100)), 'a genuinely filling pot still shows its target');
ok(/no fees have reached it in/.test(call(LIVE, 5.61, 100, true)), 'a stopped pipe still reports as stopped');
ok(/not answering right now/.test(call({ ...LIVE, potUnverified: true }, 278.48, 100)),
  '⛔ an unverified read still outranks every other state — a figure we are unsure of must not be used to claim a burn is due');

// ---- the /rewards panel: its hint GUARANTEED the behaviour that was not happening ----
const hint = src.slice(src.indexOf('function burnPanel()'));
ok(!/Fees collect until the pot reaches the threshold, then one buy goes through/.test(hint),
  '⛔ the hint no longer states a trigger that nothing fires');
ok(/waiting on a manual run/.test(hint) && /burning on the next run/.test(hint),
  'the /rewards panel tells the reader which of the two it is');
ok(/rounds are started by hand/.test(hint),
  'and names the real reason the pot keeps filling, rather than leaving it to be guessed');


// ---------------------------------------------------------------------------------------------
// And the OTHER way the panel printed a wrong pot: a cold upstream process.
//
// ⛔ THE DEPLOY THAT FIXED THE SENTENCE ABOVE EXPOSED THIS ONE. rex-rewards multiplies the pot's
// dollar figure out of two in-memory caches that only its own unrelated routes fill — the REX price
// by /api/holder, the SOL price by /api/analytics — and /api/burn touches neither. Straight after
// the restart the live feed read potRex 922961.74644, potSol 1.644328815, potUsd 0. Both chain
// figures right, the total zero. The false-zero guard could not help: it keys off potRex and potSol
// BOTH being zero, so it passed this through untouched and the strip would have said "$0.00 in the
// pot · next burn fires at $100" on a pot holding $290.
const dir = fs.mkdtempSync(`${(await import('node:os')).tmpdir()}/rex-over-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'over.sqlite';
const { __potBlockForTest: potBlock } = await import('../lib/rewards.mjs');

const COLD = { potRex: 922961.74644, potSol: 1.644328815, potUsd: 0, rexUsd: 0.0001231, solUsd: 111.00090171325519, potTargetUsd: 100, lastBurn: { at: 1790174291191 } };
const cold = potBlock(COLD, { priceUsd: 0.0001231 });
ok(cold.potUsd > 250 && cold.potUsd < 350, `⛔ a cold upstream is repriced from its own components ($${cold.potUsd.toFixed(2)}), not published as $0.00`);
ok(!cold.potUnverified, 'and needs no "unverified" label, because the components were never in doubt');

// Both sides must be counted. Pricing the REX and calling 1.64 SOL nothing was the original hole.
ok(cold.potUsd > COLD.potRex * COLD.rexUsd + 100, 'the SOL side is counted, not treated as worthless');

// An upstream that admits it could not price the pot is the same case.
const flagged = potBlock({ ...COLD, potUsd: 0, potUsdUnverified: true }, { priceUsd: 0.0001231 });
ok(flagged.potUsd > 250, 'potUsdUnverified is repriced the same way');

// No prices anywhere: say so, do not invent $0.00 for a pot the chain says is full.
const blind = potBlock({ ...COLD, potUsd: 0, rexUsd: null, solUsd: null }, null);
ok(blind.potUnverified === true, '⛔ with no price at all the pot is marked unverified, never valued at zero');

// A pot that really is empty must still read as empty. An emptied pot is what a burn looks like, so
// the zero needs a burn behind it to be believed — without one it is a failed read, which is the
// rule the guard above already enforces and which this must not quietly undo.
const empty = potBlock({ potRex: 0, potSol: 0, potUsd: 0, rexUsd: 0.0001231, solUsd: 111, potTargetUsd: 100, lastBurn: { at: Date.now() + 5000 } }, null);
ok(!empty.potUnverified && !(empty.potUsd > 0), 'a genuinely empty pot, with a burn behind it, is still reported as empty');

// A good figure from upstream is left alone.
const good = potBlock({ potRex: 922961.74644, potSol: 1.644328815, potUsd: 290.12, rexUsd: 0.0001231, solUsd: 111, potTargetUsd: 100, lastBurn: { at: 1790174291191 } }, null);
ok(good.potUsd === 290.12, 'a figure upstream could work out itself is not second-guessed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
