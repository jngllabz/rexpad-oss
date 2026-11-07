// Can a coin on the Meteora venue actually be traded, and is its curve the size we meant?
//
// ⛔ THE TWO BUGS THIS EXISTS FOR, both found when $REXWEEN became the first coin to really reach
// Meteora. It was indexed by DexScreener within minutes — and could not be bought anywhere.
//
//  1. NO TRADE ROUTE EXISTED. `quoteSwap` and `buildSwap` were written when the venue was built and
//     never wired to anything: the buy box called /api/trade, which only knows our own curve
//     program. And no aggregator will route through a curve whose real quote reserve is zero, so
//     the first trade — the one that creates that reserve — could only happen on the launchpad.
//     With no route here, every Meteora launch was permanently untradeable, everywhere.
//
//  2. THE CURVE WAS SIZED IN DOLLARS AND READ AS QUOTE TOKENS. buildCurveWithMarketCap denominates
//     both market caps in the quote asset; the form sends "$5K opening, $50K graduation". Passed
//     through unconverted against REX at $0.00011, REXWEEN's ENTIRE curve came to $1.32 — 5,000 REX
//     (56 cents) quoted for 520 MILLION of its billion supply, and a $56 buy came back
//     "Insufficient Liquidity", which reads as a broken pool rather than a pool the size of a
//     sandwich. The same number against SOL would have built a $6.1M curve nobody could graduate.
//
//   node tools/dbc_trade_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const srv = fs.readFileSync('server.mjs', 'utf8');
const met = fs.readFileSync('lib/meteora.mjs', 'utf8');
const pages = fs.readFileSync('public/pages.js', 'utf8');
const chain = fs.readFileSync('lib/chain.mjs', 'utf8');

console.log('\n── a Meteora coin can be quoted and traded through the site');
{
  ok(/sub === 'dbc\/quote'/.test(srv), 'there is a route that quotes the real Meteora pool');
  ok(/sub === 'build\/dbc-buy' \|\| sub === 'build\/dbc-sell'/.test(srv), 'and routes that build the buy and the sell');
  ok(/export async function buildSwapTx/.test(met), 'meteora.mjs packs a signable swap transaction');
  // CHAIN.act() posts to /api/chain/build/<what>, so these names are load-bearing.
  // ⛔ There are two venues now: Meteora for most pairs, LaunchLab for the taxed ones Meteora
  // refuses. The route name is chosen from the coin's venue rather than hardcoded.
  ok(/'dbc-buy' : 'dbc-sell'/.test(pages), 'the Meteora route names are still exact');
  ok(/'ll-buy' : 'll-sell'/.test(pages), 'and the LaunchLab ones');
  ok(/t\.venue === 'launchlab'\s*\n?\s*\? \(side === 'buy' \? 'll-buy'/.test(pages)
    || /const what = t\.venue === 'launchlab'/.test(pages), 'chosen by venue, not hardcoded');
  ok(/if \(t\.venue === 'dbc'\) \{ try \{ return await getQuoteDbc/.test(pages),
    'the quote preview prices the Meteora pool, not our own curve row');
  const tr = /async function doTradeOnChain[\s\S]*?\n  \}/.exec(pages)?.[0] || '';
  ok(/t\.venue === 'dbc'/.test(tr), 'doTradeOnChain branches on venue before building anything');
  ok(/q\?\.dbc \? Math\.floor\(q\.minOut/.test(tr),
    'the slippage floor comes from the SDK quote, not from our curve maths');
  // ⛔ LaunchLab builds the whole transaction server-side with its own minimum, so a floor sent
  // from here would be a second opinion in different units.
  ok(/q\?\.ll \? 0 :/.test(tr), 'and a LaunchLab trade sends none, because the server sets it');
  // Re-applying slip to a minOut the SDK already adjusted would double the tolerance.
  ok(!/minOut \* \(1 - slip/.test(tr), 'and it is not slippage-adjusted twice');
}

console.log('\n── the wrapping rules are shared, not copied');
{
  for (const k of ['packTx', 'ensureAtaIx', 'quoteInPrefix', 'quoteOutSuffix'])
    ok(new RegExp(`export const ${k}`).test(chain), `chain.mjs exports ${k} for the DBC route to reuse`);
  // ⛔ THE PREPARATION IS NOW CONDITIONAL, and that is the point: adding it unconditionally
  // duplicated what the SDK already builds and made every SOL-paired coin unbuyable. The rules
  // live in wrapperForSwap, which buildSwapTx calls — so look for them there.
  const fn = /export function wrapperForSwap[\s\S]*?\n\}/.exec(met)?.[0] || '';
  ok(fn.length > 0, 'wrapperForSwap is where a swap decides what to prepare');
  ok(/receivesQuote/.test(fn), 'a sell and a buy prepare different accounts');
  ok(/ensureAtaIx\(user, quoteMint/.test(fn),
    'a SELL creates the quote account first — the quote has nowhere to land otherwise');
  ok(/quoteInPrefix\(quoteMint, user, amountIn/.test(fn),
    'a BUY makes the quote spendable first (wrapping SOL when SOL is the quote)');
  ok(/w\.closes \? \[\] :/.test(fn),
    '⛔ and NEITHER is added when the SDK already did it — two closes is InvalidAccountData');
  const bs = /export async function buildSwapTx[\s\S]*?\n\}/.exec(met)?.[0] || '';
  ok(/wrapperForSwap\(/.test(bs), 'buildSwapTx uses it rather than keeping its own copy');
  ok(!/CH\.quoteOutSuffix\(quoteMint, owner\)/.test(bs),
    'and no longer closes the wrapper unconditionally');
  ok(/tokenProgramOf/.test(met),
    'the ATA is derived under the right token program — REX is Token-2022, and the wrong program is a different address');
}

console.log('\n── a refused quote and a doomed trade both answer in words');
{
  const qr = /if \(sub === 'dbc\/quote'\)[\s\S]*?\n      \}\n/.exec(srv)?.[0] || '';
  ok(/Insufficient Liquidity/i.test(qr), 'the quote route recognises the curve\'s own refusal');
  ok(/maxFillable\(/.test(qr), '⛔ and answers with the size that WOULD fill, not the two words');
  ok(/Math\.floor\(exact \* step\)/.test(qr),
    '⛔ rounded DOWN — naming a size that still will not fill is worse than the refusal');
  ok(/maxIn:/.test(qr), 'and the raw figure is returned so the client can offer it as a button');

  const br = /if \(sub === 'build\/dbc-buy' \|\| sub === 'build\/dbc-sell'\)[\s\S]*?\n      \}\n/.exec(srv)?.[0] || '';
  // ⛔ A hooked coin whose rule was never switched on reverts EVERY transfer — the program says
  // 6071, the person sees an error code, and we hear "some tokens don't work".
  ok(/ruleIsOn\(/.test(br), 'a hooked coin is checked for an initialised rule before any swap is built');
  ok(/never switched on/.test(br), 'and the refusal says so in words a launcher can act on');
  ok(/catch \(e\) \{ warn\('rule check'/.test(br),
    '⛔ and a check we could not RUN does not block the trade — unreadable is not the same as absent');
  ok(/explainBeforeSending\(/.test(br), 'a trade is simulated before a wallet ever sees it');
  ok(/json\(res, 400, \{ error: no \}\)/.test(br), 'and a doomed one is refused with that sentence');
}

console.log('\n── the curve is sized in the quote asset, from a USD intent');
{
  const route = /if \(sub === 'dbc\/build'\) \{([\s\S]*?)\n      \}\n/.exec(srv)?.[1] || '';
  ok(/usdOf\(q\?\.symbol/.test(route), 'the quote asset\'s USD price is read at launch time');
  ok(/initialMarketCap: capUsd \/ qUsd/.test(route) && /migrationMarketCap: migUsd \/ qUsd/.test(route),
    'both market caps are converted into quote units before the curve is built');
  ok(!/initialMarketCap: Math\.max\(100, Number\(body\.initialMarketCap\)/.test(route),
    'the raw USD figure is no longer passed through as a token amount');
  // A fallback price is what sized REXWEEN. There is no safe default here: the curve cannot be
  // resized after creation, so an unknown price has to stop the launch.
  ok(/if \(!\(qUsd > 0\)\) return json\(res, 503/.test(route),
    'an unknown price REFUSES the launch rather than guessing a size');
  ok(/migUsd <= capUsd/.test(route), 'and graduation above opening is enforced');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
