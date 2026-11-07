/**
 * Callouts — you call a coin in public, and what happens next is on the record.
 *
 * Elio's ask, 7 Oct, forwarding @Bagworkerapp: "Bag working is no longer a term, we created an app
 * for it. Make a callout, get paid directly to your wallet." — "Let's add".
 *
 * ⛔ THE MONEY SIDE OF THIS ALREADY EXISTS AND IS NOT REBUILT HERE. REX Chain already pays whoever
 * brings volume to a coin: `referrals` records who brought whom per coin, `ref_credit` accumulates
 * the volume they brought, and every settle splits `ref_share_bps` of the creator's cut among them
 * pro-rata. A second ledger paying for the same thing would be two sources of truth for one promise,
 * and the first disagreement between them is somebody's money.
 *
 * So a callout is the SOCIAL half of a mechanism that already has an economic half. Posting one
 * carries your referral code for that coin; anybody who buys through it is attributed to you by the
 * existing path, and you are paid by the existing path. What is new is the public record:
 *
 *   ⛔ THE PRICE IS STAMPED AT THE MOMENT OF THE CALL AND NEVER UPDATED. A caller's record is worth
 *   exactly as much as the guarantee that the entry was fixed before anyone knew the answer. Every
 *   figure below — the peak, the multiple, whether it is up or down — is DERIVED by comparing that
 *   frozen number against candles the indexer wrote, so a caller cannot improve their record and
 *   nor can we.
 */
import { db } from './db.mjs';
import { cfg } from './config.mjs';
import { usdOf } from './prices.mjs';
import { refCodeOf } from './engine.mjs';

/** One call per wallet per coin inside this window — a caller with a view does not need ten of them. */
const COOLDOWN_MS = Number(process.env.CALLOUT_COOLDOWN_MS || 6 * 3600_000);
const MAX_LEN = 280;

export const cooldownMs = () => COOLDOWN_MS;

/**
 * Post a callout.
 *
 * The caller has to be holding the coin. That is the one rule worth having: a call from somebody
 * with nothing on it is a free option, and a board full of free options tells a reader nothing.
 */
export function post(wallet, mint, text, xUrl = null) {
  const t = db.prepare('SELECT mint, symbol, price, quote, status FROM tokens WHERE mint=?').get(mint);
  if (!t) return { ok: false, error: 'no such coin' };
  if (!(Number(t.price) > 0)) return { ok: false, error: 'that coin has no price yet — it cannot be called' };

  const held = db.prepare('SELECT amount FROM holdings WHERE wallet=? AND mint=?').get(wallet, mint)?.amount || 0;
  if (!(held > 0)) return { ok: false, error: `Buy some $${t.symbol} first — a callout has to carry your own position.` };

  const last = db.prepare('SELECT ts FROM callouts WHERE wallet=? AND mint=? ORDER BY ts DESC LIMIT 1').get(wallet, mint);
  if (last && Date.now() - last.ts < COOLDOWN_MS) {
    const left = Math.ceil((COOLDOWN_MS - (Date.now() - last.ts)) / 60_000);
    return { ok: false, error: `You already called $${t.symbol}. You can call it again in ${left > 60 ? Math.ceil(left / 60) + 'h' : left + 'm'}.` };
  }

  const clean = String(text || '').trim().slice(0, MAX_LEN);
  // The X link is optional and is stored as given, after the same structural check Post & earn uses.
  const x = xUrl ? String(xUrl).trim().slice(0, 300) : null;
  const ts = Date.now();
  const mcap = Number(t.price) * 1e9 * (usdOf(t.quote) || 0);
  const r = db.prepare(`INSERT INTO callouts(mint,wallet,text,x_url,price_at,mcap_at,quote,ts) VALUES(?,?,?,?,?,?,?,?)`)
    .run(mint, wallet, clean || null, x, Number(t.price), mcap, t.quote, ts);
  return { ok: true, id: Number(r.lastInsertRowid), priceAt: Number(t.price), mcapAt: mcap, ts, code: refCodeOf(wallet) };
}

/**
 * The best price a coin reached after a given moment, from the candles the indexer wrote.
 *
 * ⛔ NULL WHEN THERE IS NO DATA, NEVER THE ENTRY PRICE. Falling back to the entry would render as
 * "1.00x" — a flat call — which is a specific claim about how it went, made out of an absence of
 * information. A call with nothing to measure yet says so.
 */
export function peakSince(mint, ts) {
  const r = db.prepare('SELECT MAX(h) h, MAX(ts) last FROM candles WHERE mint=? AND ts>=?').get(mint, ts);
  return r?.h > 0 ? { peak: r.h, at: r.last } : null;
}

/** Decorate a stored callout with everything that can be derived about how it went. */
function enrich(c) {
  const t = db.prepare('SELECT symbol, name, image, price, quote, status FROM tokens WHERE mint=?').get(c.mint) || {};
  const pk = peakSince(c.mint, c.ts);
  const now = Number(t.price) || 0;
  const entry = Number(c.price_at) || 0;
  return {
    id: c.id, mint: c.mint, wallet: c.wallet, text: c.text, xUrl: c.x_url, ts: c.ts,
    symbol: t.symbol, name: t.name, image: t.image, quote: t.quote || c.quote, status: t.status,
    priceAt: entry, mcapAt: c.mcap_at,
    // ⛔ null, not 1, when nothing has been recorded since the call.
    peakX: pk && entry > 0 ? pk.peak / entry : null,
    nowX: now > 0 && entry > 0 ? now / entry : null,
    mcapNow: now * 1e9 * (usdOf(t.quote || c.quote) || 0),
  };
}

/** The public feed, newest first. `mint` narrows it to one coin, `wallet` to one caller. */
export function feed({ mint = null, wallet = null, limit = 40 } = {}) {
  const n = Math.min(100, Math.max(1, Number(limit) || 40));
  const rows = mint
    ? db.prepare('SELECT * FROM callouts WHERE mint=? ORDER BY ts DESC LIMIT ?').all(mint, n)
    : wallet
      ? db.prepare('SELECT * FROM callouts WHERE wallet=? ORDER BY ts DESC LIMIT ?').all(wallet, n)
      : db.prepare('SELECT * FROM callouts ORDER BY ts DESC LIMIT ?').all(n);
  return rows.map(enrich);
}

/**
 * The caller board.
 *
 * Ranked by the MEDIAN multiple, not the mean and not the best. One call that went 40x should not
 * outrank thirty that went 2x — the mean is exactly the statistic a caller games by spraying, and
 * "best call" is that failure taken to its limit. The median asks the only question a reader has:
 * if I follow this person, what usually happens?
 */
export function board({ limit = 25, minCalls = 1 } = {}) {
  const rows = db.prepare('SELECT * FROM callouts ORDER BY ts DESC LIMIT 2000').all();
  const by = new Map();
  for (const c of rows) {
    const e = enrich(c);
    if (!by.has(c.wallet)) by.set(c.wallet, { wallet: c.wallet, calls: 0, xs: [], last: 0, best: null });
    const g = by.get(c.wallet);
    g.calls++;
    g.last = Math.max(g.last, c.ts);
    if (e.peakX != null) { g.xs.push(e.peakX); if (!g.best || e.peakX > g.best.peakX) g.best = e; }
  }
  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const out = [];
  for (const g of by.values()) {
    if (g.calls < minCalls) continue;
    // Volume brought and earned come from the referral ledger — the same rows that pay them.
    const credit = db.prepare('SELECT COALESCE(SUM(volume),0) v, COALESCE(SUM(earned),0) e FROM ref_credit WHERE referrer=?').get(g.wallet);
    out.push({
      wallet: g.wallet, calls: g.calls, lastAt: g.last,
      medianX: med(g.xs), scored: g.xs.length,
      bestSymbol: g.best?.symbol || null, bestX: g.best?.peakX ?? null,
      broughtVolume: credit?.v || 0, earned: credit?.e || 0,
    });
  }
  // A caller with nothing measurable yet sorts below everyone who has a record, rather than above.
  out.sort((a, b) => (b.medianX ?? -1) - (a.medianX ?? -1) || b.calls - a.calls);
  return out.slice(0, Math.min(100, Math.max(1, Number(limit) || 25)));
}

/** One wallet's calling record, for their profile and for the points breakdown. */
export function recordOf(wallet) {
  const mine = feed({ wallet, limit: 100 });
  const scored = mine.filter((c) => c.peakX != null).map((c) => c.peakX);
  const s = [...scored].sort((a, b) => a - b);
  const m = s.length >> 1;
  const credit = db.prepare('SELECT COALESCE(SUM(volume),0) v, COALESCE(SUM(earned),0) e FROM ref_credit WHERE referrer=?').get(wallet);
  return {
    calls: mine.length,
    medianX: s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null,
    bestX: s.length ? s[s.length - 1] : null,
    broughtVolume: credit?.v || 0,
    earned: credit?.e || 0,
    code: refCodeOf(wallet),
  };
}

export const countFor = (wallet) => db.prepare('SELECT COUNT(*) n FROM callouts WHERE wallet=?').get(wallet).n;
export const stats = () => ({
  total: db.prepare('SELECT COUNT(*) n FROM callouts').get().n,
  callers: db.prepare('SELECT COUNT(DISTINCT wallet) n FROM callouts').get().n,
  cooldownMs: COOLDOWN_MS,
  refShareNote: 'A callout carries your referral code for that coin. Buys through it are attributed '
    + 'to you by the existing referral ledger and paid from the coin\'s referral share.',
});
