// A pair Meteora refuses is not a pair the site refuses — there is a second venue, and it takes them.
//
// ⛔ WHAT HAPPENED. Julz, 24 Oct: "Trying to pair it to different ones different errors", and the
// MASK one read: "MASK cannot be used as a pair: it charges a 3% fee on every transfer, and Meteora
// will not price a curve in an asset that shrinks in transit (error 6081). It launches on Raydium
// LaunchLab instead, which takes fee-bearing pairs." The refusal ended by naming the venue that
// would have taken it. The form agreed with the sentence and not with the server: it shows those
// pairs open, labelled "via LaunchLab", and posts `venue: 'launchlab'`.
//
// The launch route asked `quoteBlock(symbol)` — Meteora's verdict OR the cluster's, collapsed into
// one string — about 120 lines before the branch that would have sent the launch to LaunchLab. So
// GP, ZCAT, SI, MASK and ALLINU were unlaunchable on a site that offered all five. `launchlab_test`
// asserted that guard ran "BEFORE the branch", which is the bug written down as a requirement.
//
//   node tools/venue_pair_block_test.mjs
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-vpb-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'vpb.sqlite';
process.env.SIM = '1';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const { QUOTES, venueBlock, quoteBlock, quoteBlockKind } = await import('../lib/prices.mjs');

console.log('── the two reasons are not the same reason');
{
  // The seed in prices.mjs: four Token-2022 mints carrying a transfer fee, measured against mainnet.
  const feeBearing = ['ZCAT', 'SI', 'MASK', 'ALLINU'].filter((s) => QUOTES[s]);
  ok(feeBearing.length === 4, `${feeBearing.length} fee-bearing pairs to check`);
  ok(feeBearing.every((s) => quoteBlockKind(s)?.kind === 'badge'),
    'all four are blocked for a Meteora badge, not for the cluster');
  ok(feeBearing.every((s) => !!venueBlock(s, 'dbc')),
    '⛔ Meteora still refuses them — the fee is real and error 6081 is real');
  ok(feeBearing.every((s) => venueBlock(s, 'launchlab') === null),
    '⛔ and LaunchLab does not, which is the whole reason the second venue was wired up');
}

console.log('\n── a mint that is not on this cluster is refused everywhere');
{
  const sym = Object.keys(QUOTES).find((s) => !QUOTES[s].unavailable && !QUOTES[s].badgeBlock);
  const q = QUOTES[sym];
  const prev = q.unavailable;
  q.unavailable = 'devnet';
  try {
    ok(quoteBlockKind(sym)?.kind === 'cluster', `${sym} stood in as a cluster-blocked pair`);
    ok(!!venueBlock(sym, 'dbc') && !!venueBlock(sym, 'launchlab'),
      '⛔ refused on BOTH venues — there is no asset to pair with, so no venue can help');
    ok(venueBlock(sym, 'launchlab') === 'devnet', 'and says which cluster it is missing from');
  } finally { q.unavailable = prev; }
  ok(venueBlock(sym, 'dbc') === null && venueBlock(sym, 'launchlab') === null,
    `and ${sym} is open again on both once it is back`);
}

console.log('\n── an unblocked pair is open on both, and a cluster block outranks a badge');
{
  ok(venueBlock('SOL', 'dbc') === null && venueBlock('SOL', 'launchlab') === null, 'SOL is open everywhere');
  const q = QUOTES.MASK;
  const prev = q.unavailable;
  q.unavailable = 'devnet';
  try {
    ok(venueBlock('MASK', 'launchlab') === 'devnet',
      '⛔ a pair that is BOTH cluster-blocked and badge-blocked stays shut on LaunchLab');
  } finally { q.unavailable = prev; }
}

console.log('\n── the collapsed answer is still there, because the FORM wants it');
{
  // The chip labels itself per venue in the client (`onLaunchLab`), so what it needs from the
  // server is the reason, not a verdict. Narrowing `quoteBlock` would have emptied those tooltips.
  ok(quoteBlock('MASK') === quoteBlockKind('MASK').why, 'quoteBlock still answers with the reason itself');
  ok(venueBlock('MASK', 'launchlab') === null && quoteBlock('MASK') !== null,
    '⛔ and the two disagree on purpose — one describes the asset, the other answers a launch');
}

console.log('\n── the launch route asks the venue-aware question, before the venue branch');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf("if (sub === 'dbc/build')");
  const route = srv.slice(i, srv.indexOf("if (sub === 'll/confirm')"));
  // ⛔ Strip comment lines first. The comment above the guard QUOTES the old call to explain the
  // bug, so a plain grep matches the warning and reports the fix as the thing it warns about.
  const code = route.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const branch = code.indexOf("if (String(body.venue || '') === 'launchlab') {");
  const before = code.slice(0, branch);
  ok(branch > 0, 'the venue branch is in the same route');
  ok(/venueBlock\(q\.symbol, venueWanted\)/.test(before), '⛔ the guard is venue-aware');
  ok(!/quoteBlock\(q\.symbol\)/.test(before), '⛔ and the venue-blind call is gone from it');
  ok(/venueWanted = String\(body\.venue \|\| ''\) === 'launchlab'/.test(before),
    'and the venue comes from the request the client actually sends');
  // Whether LaunchLab carries the pair is the NEXT question, with its own words.
  ok(/llQuoteOf\(quoteMint\)/.test(code.slice(branch)) && /Raydium creates those/.test(route.slice(branch)),
    'a pair LaunchLab has no curve for is still refused, by name, inside the branch');
}

console.log('\n── and the sweep that sets these blocks yields to whoever is waiting');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf('async function sweepBadges()');
  const fn = srv.slice(i, srv.indexOf('\n}', i));
  ok(i > 0, 'the badge sweep is on a timer of its own');
  ok(/CH\.background\(\(\) => badgeSweep\(/.test(fn),
    '⛔ and runs as BACKGROUND work — 62 serial reads at foreground priority take the breaker\'s recovery probe from a launcher');
  ok(/15 \* 60_000/.test(fn), 'it retries every 15 minutes when it fails, which is why the priority matters');
}

console.log('\n── and the client sends that venue rather than guessing for us');
{
  const cl = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  ok(/const venue = venueFor\(f\.quote\);/.test(cl), 'the launch form resolves the venue it is posting for');
  ok(/quoteMint: q\.mint[\s\S]{0,80}venue,/.test(cl), 'and posts it with the build');
  ok(/q\.unavailable && !onLaunchLab\(q\.symbol\) \? ' blocked'/.test(cl),
    '⛔ and greys out only the pairs no venue carries — the same answer venueBlock gives');
}

console.log('\n── the CLI launcher knows about the second venue too');
{
  const cli = fs.readFileSync(new URL('./agent_launch.mjs', import.meta.url), 'utf8');
  ok(/state\.launchlab\?\.enabled/.test(cli), 'it reads which pairs LaunchLab carries');
  ok(/quoteMint: quote\.mint[\s\S]{0,60}venue,/.test(cli), '⛔ and posts a venue — it used to send none, so every pair went to Meteora');
  ok(/quote\.unavailable && venue !== 'launchlab'/.test(cli),
    '⛔ and only refuses a pair no venue carries, rather than all five fee-bearing ones');
}

console.log('\n── paying a holder is not launching a curve, and it never asks the badge');
{
  // ⛔ THIS SECTION HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH TIMES IT WAS THE
  // PROXY AND NOT THE INVARIANT. It began as a grep of ai_alloc for the literal `!quoteBlock(...)`
  // and failed on 25 Oct when the rule moved to `prices.payableAsset` while the invariant held.
  // It was then re-asserted as "a fee-bearing pair is never payable" — which was the rule at the
  // time, not the invariant either, and it failed on 26 Oct when `lib/payout.mjs` learned to cover
  // the fee and $SANTA became payable on purpose.
  //
  // What is actually true, and has been throughout: the BADGE block answers whether METEORA will
  // build a curve priced in the asset. It has nothing to say about a plain transfer to a holder.
  // A payout predicate that consults it refuses every fee-bearing mint all over again by a second
  // route, which is exactly the shape of the bug this whole file was opened for.
  const { payableAsset, quoteBlockKind, QUOTES } = await import('../lib/prices.mjs');
  const AI = await import('../lib/ai_alloc.mjs');
  // Derived, not listed: GP's badge block comes from the live sweep and the other four from the
  // seed, so which of them is shut depends on whether a sweep has run — and that is precisely the
  // sort of thing a payout must not depend on.
  const badged = Object.keys(QUOTES).filter((s) => quoteBlockKind(s)?.kind === 'badge' && QUOTES[s].transferFeeBps > 0);
  ok(badged.length >= 4, `${badged.length} fee-bearing pairs are badge-blocked, which is a VENUE's answer`);
  for (const sym of badged) {
    ok(payableAsset(sym), `${sym} is badge-blocked and still payable — the venue's answer is not the holder's`);
    ok(AI.dividendAssets().includes(sym), `  · and the model may choose ${sym}`);
  }
  // ⛔ AND THE CLUSTER HALF IS STILL ASKED, because on devnet the mint genuinely is not there.
  const sym = Object.keys(QUOTES).find((s) => payableAsset(s) && !QUOTES[s].unavailable);
  const q = QUOTES[sym];
  const prev = q.unavailable;
  q.unavailable = 'devnet';
  try {
    ok(!payableAsset(sym), `⛔ ${sym} stops being payable the moment its mint is not on this cluster`);
  } finally { q.unavailable = prev; }
  ok(payableAsset(sym), `and is payable again once it is back`);

  // ⛔ WHAT COVERING A FEE CANNOT DO. An issuer who can freeze the account or move the tokens back
  // out of it after the payout has landed is a different hazard, and no arithmetic answers it.
  for (const cat of ['stock', 'leverage']) {
    const s2 = Object.keys(QUOTES).find((k) => QUOTES[k].category === cat);
    ok(s2 && !payableAsset(s2), `${s2} is still refused — a fee can be covered, a clawback cannot`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
