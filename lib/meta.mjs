// What a link to this site unfurls as, per route.
//
// The app is a single HTML file with client-side routing, and a social crawler does not run
// JavaScript. Telegram, X, Discord and Slack read the markup the SERVER returns and nothing else —
// so without this, every link anyone ever posts, to any page, unfurls as the same site-wide card.
// That is what happened to the /pairs link: a board full of live numbers previewed as the generic
// "Launch. Build. Trade." blurb.
//
// Two rules hold everything here together:
//
//   1. THE DESCRIPTION IS THE PAGE, NOT THE PRODUCT. A preview that repeats the company pitch on
//      every route teaches people that the preview says nothing, and then they stop reading it.
//      Where a live number is cheap to fetch, it goes in — a board that says "26 pairs · $321.5K
//      24h volume" is worth unfurling; one that says "trade coins on REX Chain" is not.
//
//   2. NOTHING HERE MAY DEPEND ON WHO IS ASKING. A crawler arrives with no session, and these
//      strings are cached and re-served by the platforms that fetch them. `/me` therefore gets a
//      generic card rather than anybody's holdings: whatever this function returns can end up
//      pasted in a group chat, so it must be true for every reader at once.
//
// Everything degrades to the site default. A route that throws, or a stat that is missing, gets the
// generic card rather than a broken one — an unfurl is decoration and must never cost a page load.
import * as E from './engine.mjs';
import { db } from './db.mjs';

const money = (n) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K'
  : '$' + (Number(n) || 0).toFixed(2));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export const SITE_TITLE = 'REX Chain — Launch. Build. Trade. Discover. Grow.';
export const SITE_DESC = 'REX Chain is an ecosystem with a launch infrastructure layer at its core. '
  + "A pair clears at one sealed price, holder rewards are distributed in the pair's quote asset on "
  + 'swaps only, and every holder has a link that earns them a cut of what they bring.';

/** Routes with nothing live to say. Title and description only — they still beat one shared blurb. */
const STATIC = {
  '/create': ['Launch a coin on REX Chain',
    'Pick the pair, set the fee split and open with a sealed Fair Open so nobody gets the first bite. '
    + 'Holders are paid in the quote asset on swaps only — a send pays nothing.'],
  '/swap': ['Swap on REX Chain',
    'Every token on Solana, routed by Jupiter and settled on mainnet. Your wallet signs; nothing custodial.'],
  '/build': ['Build on REX Chain',
    'The public API behind the pad: launches, pairs, trades, holders and the fee ledger, all readable without a key.'],
  '/learn': ['How REX Chain works',
    'The sealed Fair Open, the curve, the fee buckets and how holder rewards are actually paid — in plain terms.'],
  '/points': ['Points on REX Chain',
    'What earns points, what they are worth, and where you stand.'],
  '/growth': ['Grow on REX Chain',
    'Referral links, what each one has earned, and the boards that rank them.'],
  '/me': ['Your profile on REX Chain',
    'Your holdings, your rewards and your referral earnings, in one place.'],
  '/welcome': ['Welcome to REX Chain',
    'Connect a wallet, claim a handle and pick up your referral link.'],
};

/**
 * Meta for one pathname. `card` is an absolute-from-root image URL when the route has its own,
 * otherwise undefined and the caller falls back to /og.png.
 */
export function metaFor(p) {
  try { return build(p); } catch { return { title: SITE_TITLE, desc: SITE_DESC }; }
}

function build(p) {
  if (STATIC[p]) return { title: STATIC[p][0], desc: STATIC[p][1] };

  // A token link unfurls with THAT token's card and its live numbers, not the site default.
  const tm = /^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  if (tm) {
    const tok = E.getToken.get(tm[1]);
    if (!tok) return { title: SITE_TITLE, desc: SITE_DESC };
    const pub = E.publicToken(tok);
    return {
      title: `$${tok.symbol} on REX Chain — ${money(pub.mcapUsd)} mcap`,
      desc: `${(pub.fees.holderBps / 100).toFixed(1)}% of every swap to holders in ${tok.quote}, on swaps only — a send pays nothing. `
        + `${money((tok.yield_paid || 0) * (pub.quoteUsd || 0))} paid out so far across ${tok.holders} holders.`,
      card: `/og/${tok.mint}.png`,
    };
  }

  // A public profile. Only what the page itself already shows to everyone.
  const um = /^\/u\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  if (um) {
    const name = db.prepare('SELECT name FROM wallets WHERE wallet=?').get(um[1])?.name;
    const who = name || `${um[1].slice(0, 4)}…${um[1].slice(-4)}`;
    return {
      title: `${who} on REX Chain`,
      desc: 'Launches, holdings and holder rewards earned on REX Chain.',
    };
  }

  if (p === '/pairs') {
    const { totals } = E.listPairs({ window: '24h', sort: 'volume', limit: 1 });
    const bits = [plural(totals.pairs, 'pair'), `${money(totals.volumeUsd)} 24h volume`,
      `${money(totals.rewardsUsd)} paid to holders`];
    if (totals.avgApy > 0) bits.push(`${(totals.avgApy * 100).toFixed(1)}% avg realized APY`);
    // Lead with the numbers only when there ARE numbers. On a fresh deployment the board is honest
    // and empty, and a preview headlined "$0.00 in 24h" sells a working page as a broken one. The
    // figures still appear in full in the description and on the card — this chooses which true
    // thing goes in the headline, it does not hide the other.
    return {
      title: totals.volumeUsd > 0
        ? `Pairs on REX Chain — ${plural(totals.pairs, 'pair')}, ${money(totals.volumeUsd)} in 24h`
        : 'Pairs on REX Chain — every coin paired against $REX, ranked',
      desc: `${bits.join(' · ')}. Ranked by volume, market cap, rewards paid, realized yield, movers or newest — `
        + 'and realized APY is what was actually paid out in the window, not a projection.',
      card: '/og/pairs.png',
    };
  }

  const s = E.globalStats();
  if (p === '/fair-opens') {
    return {
      title: s.fairOpensLive
        ? `${plural(s.fairOpensLive, 'Fair Open')} running on REX Chain`
        : 'Fair Opens on REX Chain',
      desc: 'Every launch opens sealed: bids go in blind and the whole book clears at one price, so nobody '
        + `fills block zero. ${plural(s.fairOpenFills || 0, 'bid')} filled so far.`,
    };
  }
  if (p === '/rewards') {
    return {
      title: s.paidUsd > 0 ? `Holder rewards on REX Chain — ${money(s.paidUsd)} paid`
        : 'Holder rewards on REX Chain',
      desc: `${money(s.paidUsd)} distributed across ${plural(s.payouts, 'payout')}, in each pair's quote asset. `
        + 'Swaps pay holders; a send pays nothing, so your coin is never sold to fund its own payout.',
    };
  }
  if (p === '/leaderboard') {
    return {
      title: 'Leaderboard — REX Chain',
      desc: `Who is launching, trading and earning across ${plural(s.launches, 'launch', 'launches')} on REX Chain.`,
    };
  }
  if (p === '/') {
    return {
      title: SITE_TITLE,
      desc: `${plural(s.launches, 'launch', 'launches')}, ${money(s.vol24Usd)} traded in 24h and ${money(s.paidUsd)} paid to holders. `
        + SITE_DESC,
    };
  }
  return { title: SITE_TITLE, desc: SITE_DESC };
}
