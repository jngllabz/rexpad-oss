// ⛔ METEORA CANNOT BE THE ONLY VENUE.
//
// DBC refuses any quote mint that charges a transfer fee — 6081 QuoteMintHasNonZeroTransferFee,
// from token.rs:232 — and no token badge changes that. Five of our pairs are in that state: $GP
// (3%), $ZCAT (3%), $MASK (3%), $SI (1%) and $ALLINU (1%). Raydium's LaunchLab takes them, which
// is why Santa Markets can launch GP-paired coins and this site cannot.
//
//   node tools/launchlab_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-ll-'));
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'll.sqlite';
delete process.env.LAUNCHLAB_PLATFORM;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const LL = await import('../lib/launchlab.mjs');
const { QUOTES } = await import('../lib/prices.mjs');

console.log('── the venue is DARK until a platform exists');
{
  ok(LL.llEnabled() === false, 'llEnabled() is false with no platform');
  let threw = null;
  await LL.llPlatform().catch((e) => { threw = e.message; });
  ok(/not open yet/.test(threw || ''), 'and reading the platform says so rather than throwing something opaque');
}

console.log('\n── ⛔ A CURVE CONFIG IS CREATED BY RAYDIUM, NOT BY US');
{
  // Without one there is nothing to launch on, so LL_CONFIGS — not our QUOTES table — is the real
  // list of what this venue can pair with. Claiming otherwise would promise pairs that cannot work.
  ok(Object.keys(LL.llConfigs()).length > 0, `there are ${Object.keys(LL.llConfigs()).length} configs`);
  for (const key of Object.keys(LL.llConfigs())) {
    ok(!!QUOTES[key], `${key} is a quote this site actually knows`);
  }
  ok(!!LL.llConfigs().GP, '⛔ and GP is one of them — the pair Meteora refuses');
}

console.log('\n── a quote is built from our own table, so decimals are never retyped');
{
  const gp = LL.llQuoteOf('GP');
  ok(gp && gp.mint === QUOTES.GP.mint, 'GP resolves to the mint in QUOTES');
  ok(gp.dec === QUOTES.GP.decimals, `and its decimals come from there too (${gp.dec})`);
  ok(LL.llQuoteOf(QUOTES.GP.mint)?.key === 'GP', 'it resolves by mint address as well as by key');
  ok(LL.llQuoteOf('NVDAx') === null, '⛔ a quote with no LaunchLab config resolves to nothing, not to a guess');
  ok(LL.llQuoteOf('') === null && LL.llQuoteOf(null) === null, 'and so does nonsense');
  ok(LL.llQuoteOf('SOL')?.native === true, 'SOL is marked native, so the wrapper is handled');
  ok(LL.llQuoteOf('GP')?.native === false, 'and GP is not');
}

console.log('\n── the curve maths is arithmetic and needs no chain');
{
  const gp = LL.llQuoteOf('GP');
  const c = LL.llCurveFor(5000 / 0.0065, gp);     // a $5,000 open, in GP at about $0.0065
  ok(c.raise > 0, `it raises ${c.raise.toFixed(0)} GP`);
  ok(c.startPx > 0 && c.endPx > c.startPx, 'and the curve ends higher than it starts');
  ok(Math.abs(c.startMcapQuote / (5000 / 0.0065) - 1) < 0.02,
    `the opening market cap lands where it was asked to (${c.startMcapQuote.toFixed(0)} vs ${(5000 / 0.0065).toFixed(0)})`);
  ok(c.endMcapQuote > c.startMcapQuote, 'graduation is above the open');

  // ⛔ A pair worth too little per unit cannot carry a curve, and must say so rather than
  // producing an Infinity that becomes a transaction.
  let threw = null;
  try { LL.llCurveFor(0, gp); } catch (e) { threw = e.message; }
  ok(/cannot carry a curve/.test(threw || ''), 'a zero-size curve is refused in words');
}

console.log('\n── the pool address is derived, not searched for');
{
  const gp = LL.llQuoteOf('GP');
  const mint = QUOTES.REX.mint;
  const a = LL.llPoolId(mint, gp).toBase58(), b = LL.llPoolId(mint, gp).toBase58();
  ok(a === b, 'it is deterministic');
  ok(LL.llPoolId(mint, LL.llQuoteOf('SOL')).toBase58() !== a, 'and different per pair token');
  const v = LL.llVaults(a, mint, gp.mint);
  ok(v.vaultBase !== v.vaultQuote, 'the two vaults are distinct accounts');
}

console.log('\n── ⛔ THE PLATFORM CANNOT BE CREATED WITH SETTINGS THE PROGRAM WOULD REFUSE');
{
  const args = { admin: QUOTES.REX.mint, claimWallet: QUOTES.REX.mint, rewardWallet: QUOTES.REX.mint,
    cpConfig: 'CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ' };
  const bad = (o) => { try { LL.llCreatePlatformIx({ ...args, feeRate: 20000, creatorFeeRate: 5000, ...o }); return null; } catch (e) { return e.message; } };
  ok(/caps the launcher fee/.test(bad({ creatorFeeRate: 6000 }) || ''), 'a launcher fee above 0.5% is refused here, not on chain');
  ok(/caps the platform fee/.test(bad({ feeRate: 60000 }) || ''), 'and a platform fee above 5%');
  ok(/add up to 100/.test(bad({ lp: { platform: 50, creator: 0, burn: 10 } }) || ''), 'and an LP split that does not add up');
  ok(bad({}) === null, 'the defaults are accepted');
}

console.log('\n── the admin route is gated and does nothing without execute');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf("p === '/api/admin/launchlab/platform'");
  const route = srv.slice(i, i + 1400);
  ok(i > 0, 'the route exists');
  ok(/adminOk\(\)/.test(route), 'behind the admin gate');
  ok(/execute: body\.execute === true/.test(route),
    '⛔ and it only signs when asked explicitly — a GET or a plain POST is a dry run');
}

console.log('\n── ⛔ ONE BUILD ROUTE, TWO VENUES');
{
  // Name and ticker, the pair block, the SOL floor, the dev-buy balance check, the decimals read
  // off the chain, the curve sized in quote units rather than dollars — every one of those guards
  // was written because it had already gone wrong once. A second route would start without them
  // and acquire them again one incident at a time.
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf("if (sub === 'dbc/build')");
  const route = srv.slice(i, srv.indexOf("if (sub === 'll/confirm')"));
  // ⛔ ANCHOR ON THE `if`, NOT ON THE CONDITION. The guard below now reads the venue too, so
  // matching the bare condition finds that line instead and "before the branch" becomes three
  // lines of nothing — four assertions that pass on an empty string and prove nothing.
  const branch = route.indexOf("if (String(body.venue || '') === 'launchlab') {");
  ok(branch > 0, 'the LaunchLab branch lives inside the same build route');
  const before = route.slice(0, branch);
  ok(/LAUNCH_SOL_FLOOR/.test(before), '⛔ the SOL floor check runs BEFORE the branch');
  ok(/held\.spendable < devBuy/.test(before), '⛔ and the dev-buy balance check');
  ok(/decimalsOf\(CH\.conn\(\), quoteMint\)/.test(before), '⛔ and the decimals still come from the chain');
  // ⛔ AND THE PAIR BLOCK — BUT ASKED OF THE VENUE. This line used to assert `quoteBlock(q.symbol)`,
  // which is the whole bug written down as a requirement: that answer is Meteora's refusal OR the
  // cluster's, collapsed, so running it before the branch refused every pair Meteora will not take
  // — including the five the branch below exists to carry. GP, ZCAT, SI, MASK and ALLINU were
  // offered on the form as "via LaunchLab" and refused by the server for 18 days. Julz, 24 Oct.
  ok(/venueBlock\(q\.symbol, venueWanted\)/.test(before), '⛔ and the pair block, asked of the venue being launched on');
  ok(!/quoteBlock\(q\.symbol\)/.test(before), '⛔ never the venue-blind one, which closes LaunchLab for Meteora\'s reasons');
  ok(/capUsd \/ qUsd/.test(route), 'the curve is sized in quote units, not dollars');

  const ll = route.slice(branch);
  ok(/llEnabled\(\)/.test(ll), 'it refuses when the venue is off');
  ok(/llQuoteOf\(quoteMint\)/.test(ll), 'and when the pair has no LaunchLab curve');
  ok(/body\.hook\) return json\(res, 400/.test(ll),
    '⛔ a transfer rule is refused here — this venue sets a transfer FEE, not a hook, so a rule would be silently dropped');
  ok(/llCurveFor\(capUsd \/ qUsd, Q\)/.test(ll), 'the curve comes from the same USD intent');
  ok(/devBuy > 0n/.test(ll) && /buy\.ixs/.test(ll), 'the opening buy rides inside the launch transaction');
}

console.log('\n── the coin is recorded only after the chain says the pool is real');
{
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const i = srv.indexOf("if (sub === 'll/confirm')");
  const route = srv.slice(i, i + 1600);
  ok(/live\.owner\.equals\(LL\.LL_PROGRAM\)/.test(route),
    '⛔ OWNERSHIP, not existence — any funded address passes an existence check');
  ok(/venue: 'launchlab'/.test(route), 'and it is recorded as a LaunchLab coin');
  ok(/saveImage\(body\.image\)/.test(route), 'the artwork is saved to a file, never stored as a data: URL');
}

console.log('\n── the trade box routes by venue, and the two venues answer in different units');
{
  const pg = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
  ok(/'\/api\/chain\/ll\/quote' : '\/api\/chain\/dbc\/quote'/.test(pg), 'the quote is routed by venue');
  ok(/const ll = t\.venue === 'launchlab'/.test(pg) && /ll \? Number\(r\.out\) :/.test(pg),
    '⛔ LaunchLab answers in whole tokens and Meteora in raw units — dividing both is a factor of a million on screen');
  ok(/'ll-buy' : 'll-sell'/.test(pg), 'and so is the build');
  ok(/venueFor\(f\.quote\)/.test(pg), 'the launch picks its venue from the pair');
  ok(/onLaunchLab\(q\.symbol\) && q\.unavailable \? 'via LaunchLab'/.test(pg),
    '⛔ a pair Meteora refuses is shown as launchable elsewhere, not greyed out');
}


// ---------------------------------------------------------------------------------------------
// The pair list is derived, not typed — and a bad scan must never retire the venue.
//
// ⛔ THE HAND-TYPED LIST SAID THREE PAIRS WHILE RAYDIUM HAD CONFIGS FOR SEVEN. ZCAT, SI, MASK and
// ALLINU all have LaunchLab curve configs on chain and always did; because they were absent from
// the map the site never offered them a venue, so all four sat greyed out as "no Meteora badge"
// on the META tab. They are Token-2022 with transfer fees of 3%, 1%, 3% and 1%, which is why
// Meteora refuses them (6081 quoteMintHasNonZeroTransferFee) — while $GP charges the same 3% and
// launches on LaunchLab perfectly well. Julz: "On the metas only stonk seems to be only one that
// works." STONK is the one plain SPL mint with no fee in that category. He was exactly right.
{
  const LL = await import('../lib/launchlab.mjs');
  const { QUOTES } = await import('../lib/prices.mjs');

  // Derivation correctness: curve 0 / index 0 must reproduce the three addresses read off chain.
  for (const [sym, want] of Object.entries(LL.LL_SEED_CONFIGS)) {
    ok(LL.llConfigIdFor(QUOTES[sym].mint) === want,
      `the derived config for ${sym} matches the address read off the chain`);
  }

  // The four that were dead derive to real, distinct addresses.
  const metas = ['ZCAT', 'SI', 'MASK', 'ALLINU'];
  const ids = metas.map((s) => LL.llConfigIdFor(QUOTES[s].mint));
  ok(new Set(ids).size === 4, 'each dead META pair derives its own distinct config address');
  ok(!ids.some((id) => Object.values(LL.LL_SEED_CONFIGS).includes(id)),
    'and none of them collides with a seeded pair');

  // ⛔ A FAILED SCAN LOOKS EXACTLY LIKE "RAYDIUM SUPPORTS NOTHING". With no cache populated the
  // venue must fall back to the seeds rather than reporting zero pairs and turning itself off.
  const pairs = LL.llPairs();
  ok(pairs.length >= 3, `an unscanned process still offers ${pairs.length} pairs, not zero`);
  ok(pairs.includes('GP'), 'and GP among them — the pair Meteora refuses');
  ok(Object.keys(LL.llConfigs()).length >= 3, 'llConfigs() is never empty either');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
