// The featured coin bar.
//
// A short list of coins worth pointing at, led by REX itself. They are MAINNET coins while this
// site may be pointed at devnet, and that is the whole reason this file is careful about one thing:
// a featured coin sits next to a book of test launches whose money is worth nothing. A bar that did
// not say which was which would be the single most misleading element on the page, so every entry
// carries `external` and `cluster` and the UI labels it rather than leaving the viewer to guess.
//
// TWO SOURCES, because one is not enough. stonk.fun's public API knows its own launches and nothing
// else — it has REXMARS, and it has never heard of REX, which is a pump.fun mint. Featuring the
// token the entire site is denominated in is not optional, so anything stonk.fun does not carry
// falls through to DexScreener, which knows every pair on Solana.
//
// Everything here degrades to "no bar". A featured slot is decoration; it must never be able to
// take the page down, block a render, or stall a request waiting on somebody else's API.
import { cfg, warn } from './config.mjs';

const STONK = 'https://www.stonkfun.xyz/api/public/v1/tokens';
const DEX = 'https://api.dexscreener.com/latest/dex/tokens';
const H = { 'user-agent': 'Mozilla/5.0 (compatible; REX/1.0)' };
// Long enough that a crowded page costs one request per coin, short enough that the number is not
// a lie.
const TTL = Number(process.env.FEATURED_TTL_MS || 120_000);

// One cache entry per mint, so a coin whose upstream is down does not blank the ones that are fine.
const cache = new Map();

/** Which coins occupy the bar. An empty list means the bar simply does not exist. */
export const mints = () => cfg.featuredMints || [];
export const enabled = () => mints().length > 0;

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** stonk.fun's own shape — richer, because it knows about launches, graduation and peak cap. */
function fromStonk(t) {
  if (!t?.mint) return null;
  const m = t.market || {};
  return {
    mint: t.mint,
    name: t.name || t.symbol,
    symbol: t.symbol,
    image: t.imageUrl || null,
    quote: t.quote?.symbol || null,
    // Where it actually trades, so the bar can link somewhere real rather than to our own devnet.
    venue: t.launchpad || null,
    pool: t.pool || null,
    priceUsd: num(m.priceUsd),
    mcapUsd: num(m.marketCapUsd),
    vol24Usd: num(m.volume24hUsd),
    change24: num(m.priceChange24h),
    peakUsd: num(m.peakMarketCapUsd),
    graduated: t.status === 'graduated',
    source: 'stonk.fun',
  };
}

/**
 * DexScreener's shape, for anything stonk.fun does not carry.
 *
 * ⛔ FILTER ON THE BASE TOKEN. A token lookup returns every pair the mint appears in, including the
 * ones where it is the QUOTE — REX's own lookup comes back with REXMARS/REX among the results. Take
 * the price off that pair and the bar reports REXMARS's numbers under REX's name. Then pick the
 * deepest of what is left: a $357 pool and a $37K pool disagree, and the thin one is the wrong
 * answer for both price and 24h move.
 */
function fromDex(mint, pairs) {
  const own = (pairs || []).filter((p) => p?.baseToken?.address === mint);
  if (!own.length) return null;
  const p = own.reduce((a, b) => (num(b.liquidity?.usd) > num(a.liquidity?.usd) ? b : a));
  return {
    mint,
    name: p.baseToken.name || p.baseToken.symbol,
    symbol: p.baseToken.symbol,
    image: p.info?.imageUrl || null,
    quote: p.quoteToken?.symbol || null,
    venue: p.dexId || null,
    pool: p.pairAddress || null,
    priceUsd: num(p.priceUsd),
    mcapUsd: num(p.marketCap) || num(p.fdv),
    vol24Usd: num(p.volume?.h24),
    change24: num(p.priceChange?.h24),
    liqUsd: num(p.liquidity?.usd),
    peakUsd: 0,
    graduated: false,
    source: 'dexscreener',
  };
}

async function fetchOne(mint) {
  // stonk.fun first: when it knows the coin it knows more about it than DexScreener does.
  try {
    const r = await fetch(`${STONK}/${encodeURIComponent(mint)}`, { headers: H, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = fromStonk((await r.json())?.data?.token);
      if (d) return d;
    }
  } catch (e) { warn('featured', 'stonk', mint.slice(0, 6), e.message); }

  try {
    const r = await fetch(`${DEX}/${encodeURIComponent(mint)}`, { headers: H, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(String(r.status));
    return fromDex(mint, (await r.json())?.pairs);
  } catch (e) { warn('featured', 'dex', mint.slice(0, 6), e.message); return null; }
}

/** One coin, cached, never throwing. A stale entry beats a slow one; an empty one beats an error. */
async function one(mint) {
  const now = Date.now();
  let c = cache.get(mint);
  if (!c) { c = { at: 0, data: null, inflight: null }; cache.set(mint, c); }
  if (c.data && now - c.at < TTL) return c.data;
  // One request in flight per coin, however many readers arrive — otherwise a cold cache under load
  // turns one upstream call into a hundred.
  if (c.inflight) { await c.inflight; return c.data; }

  c.inflight = (async () => {
    const d = await fetchOne(mint);
    if (d) { c.data = d; c.at = now; }
    // Keep whatever we had. A stale market cap is worth more than an empty bar.
    else c.at = now - Math.floor(TTL / 2);
  })().finally(() => { c.inflight = null; });
  await c.inflight;
  return c.data;
}

/**
 * Every featured coin, in configured order, with the ones that failed dropped rather than rendered
 * empty. Resolved in parallel: the bar should cost one round trip, not one per coin.
 */
export async function featured() {
  if (!enabled()) return [];
  const rex = String(cfg.rexCa || '');
  const out = await Promise.all(mints().map((m) => one(m).catch(() => null)));
  return out.filter(Boolean).map((d) => ({
    ...d,
    // REX is ours. Its artwork ships with the site, so it is sharp, instant and cannot be changed
    // out from under us by whatever CDN a third party happens to use.
    isRex: d.mint === rex,
    image: d.mint === rex ? '/brand/rex-glyph@1024.png' : d.image,
    // The two flags that stop any of this being mistaken for one of our own test coins.
    external: true,
    cluster: 'mainnet',
  }));
}
