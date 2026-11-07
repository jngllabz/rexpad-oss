// A creator must be able to choose what their holders are paid in — and only from assets that can
// actually be paid.
//
// ⛔ WHAT HAPPENED. Julz, 24 Oct: "So looks like the basket option worked however $REX is not an
// option, can you add it." REX was never missing. It has been in the payable allowlist all along
// and `payoutBasket` would have accepted it on any epoch. What was missing was any way to SAY so:
// the basket could only be set by three presets that hardcode WIF, DOGE and SOL, so eleven of the
// fourteen payable assets were unreachable from the launch form. The feature was complete at every
// layer except the one a person touches.
//
// ⛔ AND WHAT THAT UNCOVERED. `normalizeBasket` — which the launch form and the launch route both
// validate through — asked only "is this a quote?". So the MODEL could not choose $GP, and a
// request to /api/chain/meta could. A 3% transfer-fee token as a payout asset shortchanges every
// holder on every epoch for ever, in units too small for anyone to notice. The allowlist was
// written in ai_alloc as though the model were the only way in.
//
//   node tools/payout_pick_test.mjs
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-pick-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'pick.sqlite';
process.env.SIM = '1';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const E = await import('../lib/engine.mjs');
const AI = await import('../lib/ai_alloc.mjs');
const { QUOTES, payableAsset, PAYABLE_CATEGORIES: PAYABLE } = await import('../lib/prices.mjs');

// The picker's own split, which must total exactly 10_000 or normalizeBasket refuses the launch.
const splitEven = (syms) => {
  if (!syms.length) return null;
  const base = Math.floor(10_000 / syms.length);
  return syms.map((asset, i) => ({ asset, bps: base + (i === 0 ? 10_000 - base * syms.length : 0) }));
};

// ---------- the thing Julz asked for ----------
{
  ok(payableAsset('REX'), 'REX can be paid to a holder');
  const r = E.normalizeBasket([{ asset: 'REX', bps: 10_000 }]);
  ok(!r.error && JSON.parse(r.json)[0].asset === 'REX', '⛔ and a coin can now be launched paying its holders in REX');
  const mixed = E.normalizeBasket(splitEven(['REX', 'SOL', 'DOGE']));
  ok(!mixed.error, 'alongside anything else on the list');
}

// ---------- every leg count the picker offers sums to exactly 10_000 ----------
// ⛔ THREE LEGS IS THE ONE THAT BITES: 10000/3 is 3333.33, so an even split loses a basis point and
// the launch is refused with "the shares add up to 9999". The first leg carries the remainder.
{
  for (let n = 1; n <= 5; n++) {
    const legs = splitEven(Object.keys(QUOTES).filter((s) => payableAsset(s)).slice(0, n));
    const total = legs.reduce((a, l) => a + l.bps, 0);
    ok(total === 10_000, `${n} leg${n === 1 ? '' : 's'} split to exactly 10000 bps (${legs.map((l) => l.bps).join('+')})`);
    ok(!E.normalizeBasket(legs).error, `  · and the validator accepts the ${n}-leg basket`);
  }
  ok(splitEven([]) === null,
    '⛔ and clearing the last asset gives NULL, not [] — null means "paid in the quote asset", an empty array is refused');
}

// ---------- the hole the picker uncovered ----------
// ⛔ THE HOLE WAS NEVER "$GP". It was that `normalizeBasket` — which the form AND the launch route
// both validate through — asked only "is this a quote?", so the MODEL could not choose something
// the allowlist barred and a POST to /api/chain/meta could. The barred set has since changed (a
// transfer fee is covered now, not refused), and the hole has to be tested against whatever the
// set currently is rather than against the one example that was in it on the day.
{
  const barred = Object.keys(QUOTES).filter((s) => !payableAsset(s));
  ok(barred.length > 0, `${barred.length} quotes cannot pay a holder`);
  for (const sym of barred.slice(0, 6)) {
    const r = E.normalizeBasket([{ asset: sym, bps: 10_000 }]);
    ok(!!r.error, `⛔ normalizeBasket refuses ${sym} — the launch route is behind this, not just the model`);
  }
  const stock = Object.values(QUOTES).find((q) => q.category === 'stock');
  ok(stock && !payableAsset(stock.symbol),
    `${stock?.symbol} is a tokenised security whose issuer can freeze the account it is paid into, or move the tokens back out of it — and no arithmetic answers that`);
}

// ---------- the rest of Julz's list, and the chain readings that answer it ----------
// Julz, 26 Oct: "If Elio agrees / Add to basket options / Rex / Dope / Santa". REX was already in
// (above). The other two look like one request and are two different answers, and only a mint read
// tells them apart — which is the whole reason the category proxy had to go.
//
// symbol: [program, transfer fee bps, mint authority, freeze authority] — read off MAINNET 26 Oct.
const READ_26_OCT = {
  DOPE:  ['t22',    0,   null, null],
  CARDS: ['legacy', 0,   null, null],
  STONK: ['legacy', 0,   null, null],
  GP:    ['t22',    300, null, null],
  ZCAT:  ['t22',    300, null, null],
  MASK:  ['t22',    300, null, null],
  SI:    ['t22',    100, null, null],   // ⛔ not 3% — the rates were never uniform
  ALLINU:['t22',    100, null, null],
  // ⛔ $SANTA, AND THE ANSWER THAT CHANGED THE SAME DAY. It is a 3% transfer-fee Token-2022 mint,
  // byte for byte the hazard $GP is — refused at first for exactly that reason. The owner's reply
  // was "build the gross-up so santa works", so `lib/payout.mjs` now works every leg back from its
  // ARRIVAL and the pot covers the fee. Its transferFeeConfigAuthority is LIVE, which is why 300
  // here is a description for the form and never the number a transfer is sized by.
  SANTA: ['t22',    300, null, null],
};
{
  for (const sym of ['DOPE', 'CARDS', 'STONK']) {
    const [, fee, mintAuth, freezeAuth] = READ_26_OCT[sym];
    ok(fee === 0 && mintAuth === null && freezeAuth === null, `${sym} was read on chain: no transfer fee, no mint authority, no freeze authority`);
    ok(payableAsset(sym), `  · so ${sym} can pay a holder, though its category is 'custom'`);
    ok(!E.normalizeBasket([{ asset: sym, bps: 10_000 }]).error, `  · and a coin can be launched paying holders in ${sym}`);
  }
  ok(payableAsset('SANTA') && QUOTES.SANTA?.transferFeeBps === 300,
    '⛔ SANTA can pay holders, and only because the rail covers its 3% — see tools/payout_fee_gross_test.mjs');
  ok(!E.normalizeBasket([{ asset: 'SANTA', bps: 10_000 }]).error, '  · and a coin can be launched paying holders in SANTA');

  // ⛔ THE FLAG CANNOT BE WRITTEN WITHOUT THE READING. `payout: true` is a claim about a mint, and
  // the only thing that makes it safe to write by hand is that most of it is unfalsifiable
  // afterwards: extensions are fixed when a mint is initialised and a nulled authority cannot be
  // restored. The FEE is the exception — it is mutable — which is why the rail asks the chain for
  // it at send time and the figure here is only ever shown to a creator.
  for (const [sym, q] of Object.entries(QUOTES)) {
    if (q.payout !== true) continue;
    ok(!!READ_26_OCT[sym], `${sym} carries payout:true AND a recorded chain reading`);
    ok(READ_26_OCT[sym]?.[1] === (q.transferFeeBps || 0),
      `  · whose recorded fee (${READ_26_OCT[sym]?.[1]} bps) is what the table tells a creator`);
    ok(READ_26_OCT[sym]?.[3] === null, `  · and whose freeze authority was read as null — that one cannot be covered`);
  }
  const src = fs.readFileSync(new URL('../lib/prices.mjs', import.meta.url), 'utf8');
  const pred = src.slice(src.indexOf('export const payableAsset'), src.indexOf('export const payableAsset') + 300);
  // ⛔ THE BADGE BLOCK IS NOT ASKED, ON PURPOSE. `quoteBlock` folds "not on this cluster" together
  // with "Meteora has issued no token badge" — and the second is a VENUE's answer about building a
  // curve, which would refuse every fee-bearing mint all over again by a second route. The cluster
  // half is asked, because on devnet the mint genuinely is not there.
  ok(/q\.unavailable/.test(pred) && !/quoteBlock\(/.test(pred),
    '⛔ the predicate asks the CLUSTER block and not the badge one');
  ok(!PAYABLE.has('custom') && !PAYABLE.has('stock') && !PAYABLE.has('leverage') && !PAYABLE.has('meta'),
    '⛔ and the categories were never widened — every one of these came in by name, with a reading');
}

// ---------- one predicate, not two lists ----------
{
  const ai = AI.dividendAssets();
  ok(ai.length > 0 && ai.every((s) => payableAsset(s)), `the model's allowlist IS the payable set (${ai.length} assets)`);
  const payable = Object.keys(QUOTES).filter((s) => payableAsset(s));
  ok(ai.length === payable.length, '⛔ exactly — two lists that merely agree today are two lists that drift');

  const alloc = fs.readFileSync(new URL('../lib/ai_alloc.mjs', import.meta.url), 'utf8');
  ok(!/new Set\(\['native'/.test(alloc), '⛔ and the categories are no longer written out in ai_alloc, where only the model could see them');
}

// ---------- the reader was deliberately NOT tightened ----------
// ⛔ A LIVE COIN MUST KEEP PAYING WHAT IT ALREADY PROMISED. Enforcing payability in `payoutBasket`
// would silently stop the epochs of any coin already holding such a basket rather than refusing a
// new mistake, and a stopped epoch looks like nothing at all. The write is the right seam. Nothing
// stored can be affected anyway: every basket on the board was written through normalizeBasket.
{
  const still = E.payoutBasket({ payout_assets: JSON.stringify([{ asset: 'GP', bps: 10_000 }]) });
  ok(!still.error && still.legs?.[0]?.asset === 'GP',
    '⛔ payoutBasket still PAYS a basket that is already stored — refusing on the read would strand a live coin');
  const eng = fs.readFileSync(new URL('../lib/engine.mjs', import.meta.url), 'utf8');
  const norm = eng.slice(eng.indexOf('export function normalizeBasket'));
  ok(/payableAsset\(/.test(norm.slice(0, 1200)), 'and the check sits in normalizeBasket, which is what both the form and the route validate through');
}

// ---------- the form derives its buttons, it does not list them ----------
{
  const ui = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  ok(/id="advPayAssets"/.test(ui), 'the launch form has a payout-asset control at all — the gap Julz actually hit');
  const block = ui.slice(ui.indexOf('id="advPayAssets"') - 1400, ui.indexOf('id="advPayAssets"') + 400);
  // Bounded by the control's own markup: the fields that follow it quote creator-cut percentages,
  // and a window wide enough to reach them makes the rate check below pass or fail on the wrong text.
  const pickStart = ui.indexOf('id="advPayAssets"');
  const block2 = ui.slice(pickStart, ui.indexOf('</div></div>`;', pickStart));
  ok(/payableAssets\(\)/.test(block),
    '⛔ and it is DERIVED from the server\'s allowlist, so adding a quote adds a button — a fourth hardcoded preset would have answered Julz and left the next ten unreachable');
  ok(!/'WIF'|"WIF"/.test(block), 'with no ticker typed into it');
  ok(/PAYOUT_MAX_LEGS/.test(ui) && /slice\(0, PAYOUT_MAX_LEGS\)/.test(ui), 'and a stated cap on how many assets one basket can name');
  // ⛔ AND IT SAYS WHY A PAIR IS ABSENT. Julz has now asked twice for an asset the list did not
  // show — once for one that was payable all along, once for one that never can be. A picker that
  // only shows what it allows looks identical in both cases, and the cost of that is a round trip
  // through a person every time. The rule is on the form now, not in this file.
  ok(/charges \$\{q\.transferFeeBps \/ 100\}% on every transfer/.test(block2)
     && /receive exactly the amount their payout says/.test(block2),
    '⛔ it says what a fee-bearing choice COSTS and who carries it — the pot, not the holder');
  ok(/freeze the account you paid into/.test(block2),
    'and still says why a tokenised stock cannot be on the list at all');
  // ⛔ AND IT READS THE RATE OFF THE QUOTE RATHER THAN STATING ONE. The rates differ — 3% on $ZCAT
  // and $MASK, 1% on $SI and $ALLINU — so a number typed into this sentence is wrong for half of
  // them from the day it is written, and wrong silently, in the one place a creator goes to check.
  ok(/transferFeeBps/.test(block2), 'reading each rate off the quote the server sent');
  // Comments stripped first: the block explains the differing rates in prose above the markup, and
  // a plain grep would match the explanation and report it as the thing it warns against.
  const shown = block2.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(!/\d+%/.test(shown), 'with no rate typed into the sentence');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
