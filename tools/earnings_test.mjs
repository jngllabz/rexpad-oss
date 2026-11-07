// Does the protocol's own income page show the protocol's money, to the protocol's people only?
//
// ⛔ THE CONFUSION THIS GUARDS AGAINST: a DBC swap fee splits THREE ways on one pool account —
// creator, partner, protocol — and REX Chain is the PARTNER leg. /creator reads `creatorQuoteFee`
// and /earnings reads `partnerQuoteFee`. They are adjacent fields on the same account holding
// different people's money, so swapping them would either show a launcher the protocol's income or
// hand the protocol's cut to a launcher, with no error either way. Measured on $REXWEEN the split
// in force is 40 creator / 40 partner / 20 Meteora, and both legs happened to be the SAME number
// (193.845 REX each) — which is exactly the circumstance where a mix-up looks correct.
//
// And the gate: who may see it is derived from the CONFIG ACCOUNT ON CHAIN, because migrate_config
// can move the waterfall, and a gate kept in an env var or a constant is a gate that silently stops
// matching the money it protects.
//
//   node tools/earnings_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const srv = fs.readFileSync('server.mjs', 'utf8');
const met = fs.readFileSync('lib/meteora.mjs', 'utf8');
const chain = fs.readFileSync('lib/chain.mjs', 'utf8');
const pages = fs.readFileSync('public/pages.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const route = /if \(p === '\/api\/earnings' && m === 'GET'\)([\s\S]*?)\n  \}\n/.exec(srv)?.[1] || '';

console.log('\n── the partner leg is not the creator leg');
{
  ok(/export async function partnerFeesOf/.test(met), 'meteora.mjs reads the PARTNER fees');
  const pf = /export async function partnerFeesOf[\s\S]*?\n\}/.exec(met)?.[0] || '';
  const cf = /export async function creatorFeesOf[\s\S]*?\n\}/.exec(met)?.[0] || '';
  ok(/partnerQuoteFee/.test(pf) && /partnerBaseFee/.test(pf), 'partnerFeesOf reads partnerQuoteFee/partnerBaseFee');
  ok(!/creatorQuoteFee/.test(pf), 'and never touches the creator fields');
  ok(/creatorQuoteFee/.test(cf) && !/partnerQuoteFee/.test(cf), 'creatorFeesOf is the mirror of that');
  ok(/MET\.partnerFeesOf/.test(route), 'the earnings route uses the partner read');
  ok(!/MET\.creatorFeesOf/.test(route), 'and the earnings route never reads a launcher\'s money');
}

console.log('\n── who may look is whatever the chain says gets paid');
{
  ok(/export async function protocolWallets/.test(chain), 'the wallet set is derived from the config account');
  const fn = /export async function protocolWallets[\s\S]*?\n\}/.exec(chain)?.[0] || '';
  ok(/configAccount\(\)/.test(fn), 'read live from chain, not from a constant or an env var');
  ok(/return null/.test(fn), 'an unreadable config returns null rather than an empty or full set');
  ok(/if \(!allowed\) return json\(res, 503/.test(route), 'and the route FAILS CLOSED on that null — it does not authorise');
  ok(/if \(!allowed\.has\(who\)\) return json\(res, 403/.test(route), 'a wallet outside the set is refused');
  // Refused must mean refused: no figures in the body.
  const refusal = /if \(!allowed\.has\(who\)\) return json\(res, 403, \{[^}]*\}\)/.exec(route)?.[0] || '';
  ok(!/totals|coins|Usd/.test(refusal), 'the refusal leaks no figures');
  ok(/11111111111111111111111111111111/.test(fn), 'the zero address is not treated as somebody\'s wallet');
}

console.log('\n── claiming asks the pool config, not us');
{
  const claim = /sub === 'build\/dbc-claim-partner'\)([\s\S]*?)\n      \}/.exec(srv)?.[1] || '';
  ok(claim.length > 0, 'the partner claim route exists');
  ok(/MET\.feeClaimerOf\(CH\.conn\(\), t\.dbc_config\)/.test(claim),
    'it asks the POOL CONFIG who may claim — that is what the Meteora program itself will check');
  ok(/if \(claimer !== w\)/.test(claim), 'and refuses anyone else');
  ok(/if \(!claimer\) return json\(res, 503/.test(claim), 'an unreadable config refuses rather than guessing');
  // Matches the READ, not one spelling of it — the call is wrapped in CH.readWithRetry now, so one
  // throttled refusal no longer dead-ends a claim. The property is that the ceiling comes from a
  // fresh server-side read rather than from the client, which the wrapper keeps.
  ok(/await (CH\.readWithRetry\(\(\) => )?MET\.partnerFeesOf/.test(claim),
    'the ceiling is re-read server-side, not taken from the client');
  ok(/export async function buildClaimPartnerTx/.test(met), 'and the transaction builder exists');
}

console.log('\n── unknown is not zero, and the split is shown as the chain states it');
{
  ok(/let partner = null/.test(route), 'an unread pool stays null');
  ok(/unknown: coins\.some\(\(c\) => c\.venue === 'dbc' && c\.partner === null\)/.test(route),
    'the totals declare when something could not be read');
  ok(/unreadable/.test(pages) && /'—'/.test(pages), 'the page prints a dash for unknown rather than a figure');
  ok(/export async function waterfall/.test(chain), 'the payout split is read from chain');
  // The legs summing to 100% is the invariant migrate_config can break; the page must SAY so.
  ok(/wf\.totalBps === 10000/.test(pages), 'the page checks the legs sum to exactly 100%');
  ok(/not 100% — a distribution would pay out the wrong amount/.test(pages),
    'and says plainly what it would mean if they did not');
}

console.log('\n── internal means internal');
{
  ok(/\[\/\^\\\/earnings\$\/, \(\) => P\.earnings\(app\)\]/.test(app), '/earnings is routed');
  const nav = fs.readFileSync('tools/nav_test.mjs', 'utf8');
  ok(/BY_ACTION = new Set\(\[[^\]]*'\/earnings'/.test(nav),
    'and is deliberately excluded from the public-navigation requirement, named rather than silently skipped');
  const html = fs.readFileSync('public/index.html', 'utf8');
  ok(!/href="\/earnings"/.test(html), 'it is not linked from the public chrome');
  ok(/for the wallets REX Chain pays out to/.test(srv), 'and a refused visitor is told what the page is');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
