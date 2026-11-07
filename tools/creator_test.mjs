// Does a launcher see what their coin actually owes them, and can they take it?
//
// ⛔ THE TRAP THIS WHOLE FEATURE SITS ON: WHERE A COIN'S CREATOR FEE LIVES DEPENDS ON ITS VENUE.
//
//   our own curve  →  accrues into `creator_pot` in OUR DATABASE, because our program splits each
//                     swap into five buckets we control.
//   Meteora DBC    →  accrues ON THE POOL ACCOUNT as creatorQuoteFee / creatorBaseFee, and our
//                     database never sees a cent of it.
//
// Reading the wrong source does not raise an error. It prints a confident zero next to real money:
// $REXWEEN was sitting on 193.84 REX of unclaimed creator fees while our own `trades` count for it
// still read 0. So the venue has to decide BOTH the figure and the claim route, on every row — and
// a pool that cannot be read has to come back as UNKNOWN rather than as nothing owed, because
// "you have earned nothing" is a much worse lie than "I could not check".
//
//   node tools/creator_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const srv = fs.readFileSync('server.mjs', 'utf8');
const met = fs.readFileSync('lib/meteora.mjs', 'utf8');
const eng = fs.readFileSync('lib/engine.mjs', 'utf8');
const pages = fs.readFileSync('public/pages.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

console.log('\n── the figure comes from the venue that actually holds the money');
{
  const route = /if \(p === '\/api\/creator' && m === 'GET'\)([\s\S]*?)\n  \}\n/.exec(srv)?.[1] || '';
  // ⛔ Top-level, NOT under /api/chain/: that namespace rejects every GET with 405 after its
  // POST guard, and it 503s whenever chain mode is off — which would make the dashboard a dead
  // page on the demo market for no reason. The pool reads inside it are guarded individually.
  ok(route.length > 0, 'the creator dashboard route exists, at the top level');
  ok(/t\.venue === 'dbc'[\s\S]*?creatorFeesOf/.test(route), 'a Meteora coin is read from the POOL, not from our database');
  ok(/t\.venue !== 'dbc'[\s\S]*?creator_pot/.test(route), 'a REX-curve coin is read from creator_pot');
  ok(/export async function creatorFeesOf/.test(met), 'meteora.mjs can read a pool\'s accrued creator fees');
  ok(/creatorQuoteFee/.test(met) && /creatorBaseFee/.test(met), 'and it reads both legs');
}

console.log('\n── an unreadable pool is UNKNOWN, never zero');
{
  const route = /if \(p === '\/api\/creator' && m === 'GET'\)([\s\S]*?)\n  \}\n/.exec(srv)?.[1] || '';
  ok(/let claimable = null/.test(route), 'claimable starts as null — the absence of an answer');
  ok(/unknown: coins\.some\(\(c\) => c\.claimable === null\)/.test(route),
    'the totals say when a pool did not answer, so the headline figure is a floor and not a wrong total');
  const fn = /export async function creatorFeesOf[\s\S]*?\n\}/.exec(met)?.[0] || '';
  ok(/return null/.test(fn), 'a failed pool read returns null rather than a zero balance');
  // On the page, null and 0 must not render the same.
  ok(/amt == null \? '—' :/.test(pages), 'the row prints — for unknown and a figure for known');
  ok(/data-claim="\$\{h\(c\.mint\)\}" \$\{canClaim \? '' : 'disabled'\}/.test(pages),
    'and the claim button is disabled unless there is a known, positive amount');
}

console.log('\n── only the launcher can claim, and the route follows the venue');
{
  // A slash needs no escaping inside a RegExp constructor; escaping it matches a literal backslash.
  for (const r of ['build/dbc-claim-creator', 'build/claim-creator']) {
    const body = new RegExp(`sub === '${r}'\\)([\\s\\S]*?)\\n      \\}`).exec(srv)?.[1] || '';
    ok(body.length > 0, `${r} exists`);
    ok(/t\.creator !== w/.test(body), `${r} refuses anyone who did not launch the coin`);
  }
  const claimBody = /sub === 'build\/dbc-claim-creator'\)([\s\S]*?)\n      \}/.exec(srv)?.[1] || '';
  // Claiming a stale figure races any swap landing in the same block; the ceilings come from a
  // fresh read so "claim everything" stays true at signing time.
  // Matches the READ, not one spelling of it: the call is now wrapped in CH.readWithRetry so a
  // single throttled refusal does not become "Could not read the pool just now" in front of a
  // creator who is owed money. The property under test is that the figure is fetched fresh here
  // rather than taken from the client, which the wrapper preserves.
  ok(/await (CH\.readWithRetry\(\(\) => )?MET\.creatorFeesOf/.test(claimBody),
    'the claim re-reads the pool rather than trusting the client');
  ok(/if \(!f\) return json\(res, 503/.test(claimBody), 'and refuses rather than claiming zero when the pool is unreadable');
  ok(/CHAIN\.act\(what, \{ mint \}/.test(pages) && /c\.venue === 'dbc' \? 'dbc-claim-creator' : 'claim-creator'/.test(pages),
    'the page picks the claim route by venue, the same way it picked the figure');
}

console.log('\n── a launcher can actually find it');
{
  ok(/\[\/\^\\\/creator\$\/, \(\) => P\.creator\(app\)\]/.test(app), '/creator is routed');
  ok(/href="\/creator"/.test(html), 'and linked from the persistent chrome');
  ok(/t\.creator === S\.me\?\.wallet \? `<a class="launcherbar" href="\/creator"/.test(pages),
    'a coin page tells its own launcher the dashboard exists');
  ok(/export async function creator\(root\)/.test(pages), 'the page is exported');
  ok(/if \(!S\.me\)/.test(/export async function creator\(root\)[\s\S]*?\n\}/.exec(pages)?.[0] || ''),
    'and it asks for a wallet instead of erroring when none is connected');
}

console.log('\n── the lifetime figure never pretends to be the authority');
{
  ok(/export function recordCreatorClaim/.test(eng), 'claims made through the site are recorded');
  const fn = /export function recordCreatorClaim[\s\S]*?\n\}/.exec(eng)?.[0] || '';
  ok(/NOT the authority/.test(eng.slice(Math.max(0, eng.indexOf('recordCreatorClaim') - 400), eng.indexOf('recordCreatorClaim'))) || /NOT the authority/.test(fn) || /NOT the authority/.test(eng),
    'and it is documented as a record of this site only, not of what is owed');
  ok(/claimedViaSite/.test(srv) && /Claimed through here/.test(pages),
    'the UI labels it as claimed THROUGH HERE, since a claim made elsewhere never reaches this row');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
