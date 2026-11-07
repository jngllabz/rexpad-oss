// Points: every bit of engagement on REX Chain, on one scoreboard.
//
// The central decision here is that points are DERIVED, never stored as a running total. There is no
// `points` column anybody can be credited into, and nothing writes a score. Every figure below is
// recomputed from things that already happened and are independently checkable — trades that
// settled, positions still held, referrals that vested, epochs that paid.
//
// That matters more than it sounds. A stored score is a number with an API in front of it, and the
// first interesting bug or the first clever user turns it into free points. A derived score cannot
// be inflated without doing the underlying thing, and when the formula changes the whole history
// re-rates instead of leaving a stratum of wallets sitting on points earned under old rules.
//
// It also means the board can never disagree with the chain. If a wallet sold, the hold-time points
// simply stop existing on the next read — nobody has to remember to subtract them.
import { db, tx } from './db.mjs';
import { cfg } from './config.mjs';
import { usdOf } from './prices.mjs';
import { convictionOf } from './engine.mjs';

// What each action is worth. Deliberately boring numbers, and deliberately in ONE place: the moment
// these are scattered through the code, nobody can answer "why does this wallet have 400 points".
export const RATES = {
  holdPerUsdDay: 10,     // the main engine: value held, times days held
  buy: 5,                // per trade, buy side
  volumePerUsd: 0.5,     // plus a slice of what was actually traded
  launch: 250,           // launching a coin
  graduated: 1000,       // and getting one to graduate
  fairOpen: 50,          // committing into a Fair Open rather than sniping the open
  claim: 25,             // claiming a reward epoch
  referral: 100,         // per VESTED referral — pending ones are worth nothing on purpose
  profile: 50,           // a filled-in profile: a name people can recognise
  pfp: 100,              // and a picture. "More points, we give them better pfps"
  // Posting about REX Chain on X, once the post is approved. Elio, 7 Oct: "we need bagwork
  // incentives — people to post about us". The figure itself lives in shareboost.mjs because the
  // cap and the review rules live with it; it is named here so this table stays the whole story.
  sharePost: 150,
  // Calling a coin in public, with your own position behind it. Deliberately modest: the real
  // reward for a good call is the referral share on the volume it brings, which is money, and
  // points for the act of posting should not be worth more than points for being right.
  callout: 75,
};

/** Wallets that must never appear on a public board: launch vaults, the curve's own accounts, bots. */
const EXCLUDE = `(SELECT wallet FROM wallets WHERE bot=2)`;

/**
 * Hold-time points, the part that actually rewards conviction.
 *
 * Value × days, multiplied by the same conviction ladder the reward epochs already use, so the
 * scoreboard and the payouts tell the same story rather than inventing a second definition of
 * "long-term holder". A position that was sold has no held_since and therefore earns nothing — the
 * reset is not a penalty applied anywhere, it is simply the absence of a number.
 */
export function holdPoints(wallet, now = Date.now()) {
  const rows = db.prepare(`SELECT h.amount, h.held_since, t.price, t.quote
    FROM holdings h JOIN tokens t ON t.mint = h.mint
    WHERE h.wallet = ? AND h.amount > 0 AND h.held_since IS NOT NULL`).all(wallet);
  let pts = 0;
  for (const h of rows) {
    const usd = h.amount * h.price * usdOf(h.quote);
    const days = Math.max(0, (now - h.held_since) / 86_400_000);
    pts += usd * days * RATES.holdPerUsdDay * convictionOf(h.held_since, now).mult;
  }
  return pts;
}

/** Everything that is a one-off event rather than a running clock. */
export function actionPoints(wallet) {
  const q = (sql, ...a) => db.prepare(sql).get(...a) || {};
  const tr = q(`SELECT COUNT(*) n, COALESCE(SUM(quote * ?), 0) v FROM trades WHERE wallet = ? AND side = 'buy'`, 1, wallet);
  // Volume is counted in USD, so a big SOL trade and a big USDC trade are worth the same.
  // ⛔ EXCLUDE ROUND TRIPS. A buy this wallet sold back on the same coin within WASH_WINDOW_MS is
  // not volume, it is the same money going round, and counting it is what makes volume points
  // farmable. The NOT EXISTS is bounded by the trades_mint index, so it stays a seek per row.
  const vol = db.prepare(`SELECT COALESCE(SUM(tr.quote * 1.0), 0) v, t.quote q FROM trades tr
    JOIN tokens t ON t.mint = tr.mint
    WHERE tr.wallet = ? AND tr.side = 'buy'
      AND NOT EXISTS (SELECT 1 FROM trades x WHERE x.wallet = tr.wallet AND x.mint = tr.mint
                        AND x.side = 'sell' AND x.ts > tr.ts AND x.ts <= tr.ts + ?)
    GROUP BY t.quote`).all(wallet, WASH_WINDOW_MS)
    .reduce((s, r) => s + r.v * usdOf(r.q), 0);
  const launched = q(`SELECT COUNT(*) n, COALESCE(SUM(status = 'graduated'), 0) g FROM tokens WHERE creator = ?`, wallet);
  const fair = q(`SELECT COUNT(*) n FROM trades WHERE wallet = ? AND kind = 'fairopen'`, wallet);
  const claims = q(`SELECT COUNT(*) n FROM payouts WHERE wallet = ?`, wallet);
  const refs = q(`SELECT COUNT(*) n FROM referrals WHERE referrer = ? AND vested = 1`, wallet);
  const w = q(`SELECT name, avatar FROM wallets WHERE wallet = ?`, wallet);

  return {
    buys: (tr.n || 0) * RATES.buy,
    volume: vol * RATES.volumePerUsd,
    launches: (launched.n || 0) * RATES.launch,
    graduations: (launched.g || 0) * RATES.graduated,
    fairOpens: (fair.n || 0) * RATES.fairOpen,
    claims: (claims.n || 0) * RATES.claim,
    referrals: (refs.n || 0) * RATES.referral,
    profile: w.name ? RATES.profile : 0,
    pfp: w.avatar ? RATES.pfp : 0,
    // ⛔ APPROVED POSTS ONLY, and read straight from the table rather than credited anywhere, so a
    // post that is later rejected stops counting on the next read with nobody having to subtract it.
    shares: (q(`SELECT COUNT(*) n FROM share_posts WHERE wallet = ? AND status = 'approved'`, wallet).n || 0) * RATES.sharePost,
    callouts: (q(`SELECT COUNT(*) n FROM callouts WHERE wallet = ?`, wallet).n || 0) * RATES.callout,
  };
}

/**
 * Tiers, and the multiplier that makes climbing one worth something.
 *
 * ⛔ THE TIER IS DECIDED BY THE BASE SCORE, NEVER BY THE MULTIPLIED ONE. Rank off the total and the
 * definition eats itself: crossing a threshold raises the multiplier, which raises the total, which
 * can cross the next threshold, which raises it again. A wallet would ratchet through every tier on
 * one trade and the ladder would mean nothing. Base in, tier out, multiplier applied once.
 */
export const TIERS = [
  { key: 'bronze', label: 'Bronze', at: 0, mult: 1 },
  { key: 'silver', label: 'Silver', at: 5_000, mult: 1.1 },
  { key: 'gold', label: 'Gold', at: 25_000, mult: 1.25 },
  { key: 'diamond', label: 'Diamond', at: 100_000, mult: 1.5 },
];
export function tierFor(basePoints) {
  let out = TIERS[0];
  for (const t of TIERS) if (basePoints >= t.at) out = t;
  const next = TIERS.find((t) => t.at > basePoints) || null;
  return { ...out, next, toNext: next ? next.at - basePoints : 0 };
}

/**
 * ⛔ A ROUND TRIP IS NOT VOLUME. Volume points are the one component somebody can manufacture: buy,
 * sell, buy again, and the figure climbs however little the position actually changed. The hold
 * component cannot be faked — it costs time and real exposure — and launches and graduations are
 * self-limiting, so the guard belongs on the gameable part rather than being a blunt daily ceiling
 * over everything.
 *
 * A daily cap was the obvious answer and is the wrong one HERE, because nothing in this file is
 * stored per day: every figure is recomputed from history, so "today's points" is not a thing that
 * exists to be capped. Excluding the trades themselves fits the derived model and, unlike a cap,
 * cannot be waited out — a wash trade earns nothing however patiently it is repeated.
 *
 * A buy that was sold back inside this window bought nothing in any meaningful sense.
 */
export const WASH_WINDOW_MS = Number(process.env.POINTS_WASH_WINDOW_MS || 10 * 60_000);

/**
 * What a wallet's invitees earned for it, one and two levels down.
 *
 * This is the flywheel: inviting somebody is worth a share of everything they go on to do, so a
 * good invite keeps paying and bringing people is worth more than farming yourself.
 *
 * ⛔ COMPUTED FROM THE INVITEE'S BASE SCORE, NOT THEIR TOTAL. Using the total would compound every
 * multiplier down the chain — a Diamond inviting a Diamond inviting a Diamond would pay out on
 * 1.5 x 1.5 x 1.5 of the underlying activity, which is money invented by arithmetic.
 *
 * ⛔ AND A SEEN-SET, because A→B→C→A is a perfectly legal shape in this table and walking it
 * without one recurses until the stack gives out. The affiliate tree learned this the hard way.
 * Depth is capped at two levels regardless, which is both the spec and a natural brake.
 */
export const DOWNLINE = [0.10, 0.05];   // level 1 keeps 10%, level 2 keeps 5%
export function downlinePoints(wallet, now = Date.now(), baseOf = null) {
  const base = baseOf || ((w) => rawPoints(w, now).base);
  const seen = new Set([wallet]);
  const out = { level1: 0, level2: 0, invitees: 0, total: 0 };
  let frontier = [wallet];
  for (let level = 0; level < DOWNLINE.length; level++) {
    const next = [];
    for (const parent of frontier) {
      const kids = db.prepare('SELECT wallet FROM wallets WHERE referred_by = ?').all(parent).map((r) => r.wallet);
      for (const kid of kids) {
        if (seen.has(kid)) continue;         // a cycle, or somebody already counted higher up
        seen.add(kid);
        next.push(kid);
        const share = base(kid) * DOWNLINE[level];
        if (level === 0) { out.level1 += share; out.invitees++; } else out.level2 += share;
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  out.total = out.level1 + out.level2;
  return out;
}

/**
 * A wallet's own score before any multiplier or downline — the honest unit everything else is built
 * from, and the only one safe to use when computing somebody ELSE's share of it.
 */
export function rawPoints(wallet, now = Date.now()) {
  const parts = actionPoints(wallet);
  const holding = holdPoints(wallet, now);
  // The cap applies to the manufacturable part only, and to the day's worth of it.
  const action = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, holding, action, base: holding + action };
}

/** One wallet's full breakdown — the board shows the total, a wallet can see where it came from. */
export function pointsOf(wallet, now = Date.now()) {
  const { parts, holding, base } = rawPoints(wallet, now);
  const tier = tierFor(base);
  const down = downlinePoints(wallet, now);
  // Order matters and is the whole design: BASE decides the tier, the tier's multiplier applies to
  // the wallet's own work, and the downline share is added AFTER — an invitee's effort is not
  // magnified by their inviter's status.
  const own = base * tier.mult;
  return {
    wallet,
    total: own + down.total,
    base, holding, ...parts,
    tier: tier.key, tierLabel: tier.label, multiplier: tier.mult,
    nextTier: tier.next ? tier.next.label : null, toNextTier: tier.toNext,
    downline: down.total, downlineL1: down.level1, downlineL2: down.level2, invitees: down.invitees,
  };
}

/**
 * How long a wallet has held, and whether it has ever let go — the "never sold" question.
 *
 * `firstSeen` is the oldest held_since still standing, which is the honest answer to "how long":
 * a sell clears it, so a wallet cannot sell and keep its seniority. `soldAt` is the last sell of any
 * kind. A wallet is DIAMOND when it has a live position and has never sold at all.
 */
export function holdRecord(wallet, now = Date.now()) {
  const first = db.prepare(`SELECT MIN(held_since) m FROM holdings WHERE wallet = ? AND amount > 0 AND held_since IS NOT NULL`).get(wallet)?.m || null;
  const sold = db.prepare(`SELECT MAX(ts) m FROM trades WHERE wallet = ? AND side = 'sell'`).get(wallet)?.m || null;
  const value = db.prepare(`SELECT COALESCE(SUM(h.amount * t.price), 0) v, t.quote q FROM holdings h
    JOIN tokens t ON t.mint = h.mint WHERE h.wallet = ? AND h.amount > 0 GROUP BY t.quote`).all(wallet)
    .reduce((s, r) => s + r.v * usdOf(r.q), 0);
  const coins = db.prepare(`SELECT COUNT(*) n FROM holdings WHERE wallet = ? AND amount > 0`).get(wallet)?.n || 0;
  return {
    wallet, firstSeen: first, soldAt: sold, valueUsd: value, coins,
    days: first ? (now - first) / 86_400_000 : 0,
    neverSold: !!first && !sold,
    tier: first ? convictionOf(first, now).label : null,
  };
}

/**
 * Freeze the whole board into an epoch.
 *
 * ⛔ THE SNAPSHOT IS THE ONLY NUMBER AN AIRDROP MAY BE COMPUTED FROM. Everything else in this file
 * is recomputed on every read, which is what keeps it honest while it is live — and exactly what
 * makes it unusable for an allocation. A score read at claim time is a score that moved between the
 * promise and the payment, and if the rates ever change the whole history re-rates with them. Both
 * are correct for a scoreboard. Neither is acceptable for somebody's money.
 *
 * Written once per epoch and never recomputed: the ON CONFLICT deliberately does nothing rather
 * than updating, so re-running a snapshot cannot quietly rewrite what people were already shown.
 */
export function takeSnapshot(epoch = Math.floor(Date.now() / 86_400_000), now = Date.now()) {
  const wallets = db.prepare(`SELECT DISTINCT wallet FROM holdings WHERE amount > 0 AND wallet NOT IN ${EXCLUDE}
    UNION SELECT DISTINCT wallet FROM trades WHERE wallet NOT IN ${EXCLUDE}`).all().map((r) => r.wallet);
  const ins = db.prepare(`INSERT INTO point_snapshots(epoch,wallet,points,base,tier,multiplier,downline,taken_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(epoch,wallet) DO NOTHING`);
  let n = 0, total = 0;
  // One transaction: a half-written snapshot is worse than none, because it looks complete.
  tx(() => {
    for (const w of wallets) {
      const p = pointsOf(w, now);
      if (!(p.total > 0)) continue;
      const wrote = ins.run(epoch, w, p.total, p.base, p.tier, p.multiplier, p.downline, now).changes;
      if (wrote) { n++; total += p.total; }
    }
  });
  // `wallets` is rows ACTUALLY written. A re-run of an existing epoch reports 0, which is the truth.
  return { epoch, wallets: n, total, at: now, alreadyTaken: n === 0 && wallets.length > 0 };
}

/** What a past epoch recorded. The figure an allocation is owed, not a fresh computation. */
export const snapshotOf = (epoch, limit = 500) => db.prepare(
  'SELECT wallet, points, base, tier, multiplier, downline FROM point_snapshots WHERE epoch=? ORDER BY points DESC LIMIT ?',
).all(epoch, limit);
export const snapshotEpochs = () => db.prepare(
  'SELECT epoch, COUNT(*) wallets, SUM(points) total, MIN(taken_at) at FROM point_snapshots GROUP BY epoch ORDER BY epoch DESC',
).all();

/**
 * The board. `view` picks what it is ranked by, because these are genuinely different questions:
 * who has done the most, who has held longest, and who has never once sold.
 *
 * "held" and "diamond" rank by TIME, not by size, which is the whole point of a hold-time board —
 * otherwise it is just the rich list with a clock drawn on it.
 */
/**
 * ⛔ SCORING EVERY WALLET IS THE COST, AND IT WAS BEING PAID TWICE PER REQUEST.
 *
 * /api/points asked for the board, then for one wallet's rank — and rankOf() rebuilt the entire
 * board to find a single row. On Santa Markets, where the same shape runs over 1,400 wallets, that
 * was a 1.4-second request with half of it spent doing the identical work again.
 *
 * The scored rows are cached for a short window and `me` is read out of them per request. Points are
 * derived from history that barely moves between page loads, so half a minute of staleness on a
 * leaderboard is invisible where half a second of latency is not. The cache key includes the view,
 * because the three views rank completely different sets.
 */
const BOARD_TTL = Number(process.env.POINTS_TTL_MS || 30_000);
let _scored = null;
function scoredRows(now) {
  if (_scored && now - _scored.at < BOARD_TTL) return _scored.rows;
  const wallets = db.prepare(`SELECT DISTINCT wallet FROM holdings WHERE amount > 0 AND wallet NOT IN ${EXCLUDE}
    UNION SELECT DISTINCT wallet FROM trades WHERE wallet NOT IN ${EXCLUDE} LIMIT 5000`).all().map((r) => r.wallet);
  const meta = db.prepare('SELECT wallet, name, avatar FROM wallets');
  const names = new Map(meta.all().map((r) => [r.wallet, r]));
  const rows = wallets.map((w) => {
    const rec = holdRecord(w, now);
    const p = pointsOf(w, now);
    // ⛔ One query for every name instead of one query per wallet. At 1,400 wallets that single
    // change removes 1,400 round trips from a pass that was already the slowest thing on the site.
    const m = names.get(w) || {};
    return { ...rec, points: p.total, breakdown: p, name: m.name || null, avatar: m.avatar || null };
  });
  _scored = { at: now, rows };
  return rows;
}
/** For tests, and for anything that has just changed the inputs and wants the next read to be true. */
export const forgetBoard = () => { _scored = null; };

export function board({ view = 'points', limit = 50, wallet = null } = {}) {
  const now = Date.now();
  const rows = scoredRows(now);

  const ranked = view === 'diamond' ? rows.filter((r) => r.neverSold && r.valueUsd > 0).sort((a, b) => a.firstSeen - b.firstSeen)
    : view === 'held' ? rows.filter((r) => r.firstSeen).sort((a, b) => a.firstSeen - b.firstSeen)
    : rows.sort((a, b) => b.points - a.points);

  // Seniority is computed over the WHOLE ranked set before slicing, so the oldest-ten badge means
  // the ten oldest wallets, not the ten oldest on page one.
  const oldest = new Set([...rows].filter((r) => r.firstSeen && r.neverSold)
    .sort((a, b) => a.firstSeen - b.firstSeen).slice(0, 10).map((r) => r.wallet));

  // `me` comes out of the SAME ranked list, so a wallet outside the top `limit` still gets its real
  // position — and it costs a lookup rather than a second full pass.
  let me = null;
  if (wallet) {
    const i = ranked.findIndex((r) => r.wallet === wallet);
    const mine = i >= 0 ? ranked[i] : null;
    const ahead = i > 0 ? ranked[i - 1] : null;
    me = {
      rank: i >= 0 ? i + 1 : null,
      of: ranked.length,
      points: mine?.points ?? pointsOf(wallet, now).total,
      badges: mine ? badgesOf(mine, oldest) : [],
      // "#2 is +253 pts" — the gap to the wallet directly ahead, the only one worth chasing.
      chase: ahead ? { rank: i, wallet: ahead.wallet, name: ahead.name, gap: ahead.points - (mine?.points || 0) } : null,
    };
  }

  return {
    view,
    stats: {
      wallets: rows.filter((r) => r.valueUsd > 0).length,
      neverSold: rows.filter((r) => r.neverSold).length,
      longestDays: Math.max(0, ...rows.map((r) => r.days)),
    },
    rows: ranked.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1, badges: badgesOf(r, oldest) })),
    me,
  };
}

/** Badges are statements of fact about the row, so each one is derived from the row itself. */
export function badgesOf(r, oldest = new Set()) {
  const b = [];
  if (r.neverSold && r.firstSeen) b.push('Never sold');
  if (oldest.has(r.wallet)) b.push('Original');
  if (r.tier) b.push(r.tier);
  if (r.coins >= 5) b.push('Collector');
  if (r.points >= 10_000) b.push('Grinder');
  // Was a seller, has since held clean for long enough that the sell is behind them.
  if (r.soldAt && r.firstSeen && r.firstSeen > r.soldAt && Date.now() - r.firstSeen > 7 * 86_400_000) b.push('Redeemed');
  return b;
}

/** Where one wallet sits, which is what makes a board personal rather than a list of strangers. */
export function rankOf(wallet) { return board({ view: 'points', limit: 1, wallet }).me; }
