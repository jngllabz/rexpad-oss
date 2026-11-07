// The DEX Screener adapter.
//
// This is the thing that gets a coin indexed BEFORE it graduates. DexScreener does not read our
// bonding curve and never will — it reads pool programs it has written adapters for. But it also
// supports the other direction: a DEX exposes four HTTP endpoints and DexScreener POLLS them. That
// path does not care what our program looks like, which is exactly why it works for a curve nobody
// else indexes. GeckoTerminal/CoinGecko take a near-identical shape, so this serves both.
//
// The contract is strict in one place and everything here follows from it: `latest-block` is a
// PROMISE that events are complete up to that block. Overstate it and DexScreener skips trades it
// will never ask for again, and the chart is quietly wrong forever. So it is derived from the
// highest trade actually written, never from the chain's own head.
import { db } from './db.mjs';
import { QUOTES } from './prices.mjs';
import { completeSlot, completeTs } from './indexer.mjs';

const DEX_KEY = 'rexchain';
const q = (sql) => db.prepare(sql);

/** Base units in, display units out — the spec wants decimal strings, not lamports. */
const dec = (mint) => Object.values(QUOTES).find((x) => x.mint === mint)?.decimals ?? 6;
const TOKEN_DECIMALS = 6;   // every launched token, set by the program

/**
 * Asset0/asset1 ORDER MUST NEVER CHANGE for a pair — DexScreener queries a pair once and caches it
 * forever, so flipping the sides later silently inverts every price it has ever stored. Sorting by
 * mint makes the order a property of the pair rather than of whatever we happened to write first.
 */
export function sides(tokenMint, quoteMint) {
  return tokenMint < quoteMint
    ? { asset0: tokenMint, asset1: quoteMint, tokenIs0: true }
    : { asset0: quoteMint, asset1: tokenMint, tokenIs0: false };
}

export function latestBlock() {
  // The BACKFILL's cursor — not the newest trade we happen to hold. Those are different numbers and
  // the difference is the whole bug: the live log subscription drops, the trade it dropped stays
  // missing, and the next trade to arrive still has a higher slot. Reporting the newest trade would
  // therefore promise completeness across the hole, DexScreener would advance its own cursor past
  // it, and that trade would never be asked for again. The cursor only crosses transactions we
  // actually read and recorded, so it is a number we can stand behind.
  const slot = completeSlot();
  if (!slot) return { block: { blockNumber: 0, blockTimestamp: Math.floor(Date.now() / 1000) } };
  // Prefer the cursor transaction's own block time; fall back to the newest trade at or below it.
  const ts = completeTs()
    || Math.floor(Number(q('SELECT MAX(ts) AS ts FROM trades WHERE slot IS NOT NULL AND slot<=?').get(slot)?.ts || Date.now()) / 1000);
  return { block: { blockNumber: slot, blockTimestamp: ts } };
}

export function asset(id) {
  const t = q('SELECT mint, name, symbol FROM tokens WHERE mint=?').get(id);
  if (t) {
    return { asset: { id: t.mint, name: t.name || t.symbol, symbol: t.symbol, decimals: TOKEN_DECIMALS,
      totalSupply: '1000000000' } };
  }
  const quote = Object.values(QUOTES).find((x) => x.mint === id);
  if (quote) return { asset: { id: quote.mint, name: quote.name, symbol: quote.symbol, decimals: quote.decimals } };
  return null;
}

/**
 * The quote asset's mint. Stored on the row, because resolving it from the SYMBOL is lossy: an
 * unrecognised quote is stored as the mint's first four characters, which resolves to nothing — and
 * this adapter used to drop every trade on such a pair while `latest-block` still claimed its slots.
 * That is the exact failure the completeness cursor exists to prevent, so the mint is read directly
 * and the symbol lookup is only a fallback for rows written before the column existed.
 */
const quoteMintOf = (t) => t.quote_mint || Object.values(QUOTES).find((x) => x.symbol === t.quote)?.mint || null;

export function pair(id) {
  const t = q('SELECT * FROM tokens WHERE mint=?').get(id);
  if (!t) return null;
  const quoteMint = quoteMintOf(t);
  if (!quoteMint) return null;
  const { asset0, asset1 } = sides(t.mint, quoteMint);
  const first = q('SELECT slot, ts, sig FROM trades WHERE mint=? AND slot IS NOT NULL ORDER BY slot ASC LIMIT 1').get(id);
  return {
    pair: {
      id: t.mint, dexKey: DEX_KEY, asset0Id: asset0, asset1Id: asset1,
      // The whole fee, so the number on the chart is the number a trader pays. There is no second
      // swap fee underneath it, which is the point worth it being visible.
      feeBps: t.tax_bps || 0,
      ...(first ? {
        createdAtBlockNumber: Number(first.slot),
        createdAtBlockTimestamp: Math.floor(Number(first.ts) / 1000),
        createdAtTxnId: first.sig || undefined,
      } : {}),
    },
  };
}

/**
 * Every swap in a block range, in block order. `priceNative` is asset1 per asset0 — which side that
 * is depends on the mint sort, so it is computed from the sides rather than assumed.
 */
export function events(fromBlock, toBlock) {
  // Never answer beyond the completeness cursor, even if asked. An answer is taken as final for the
  // range in the question, so returning the live stream's view of a slot the backfill has not
  // reached yet would publish a partial block as a complete one.
  const complete = completeSlot();
  const hi = complete > 0 ? Math.min(Number(toBlock), complete) : Number(toBlock);
  if (hi < Number(fromBlock)) return { events: [] };
  const rows = q(`SELECT t.*, k.quote AS quote_symbol, k.quote_mint, k.v_quote, k.v_tokens, k.real_quote, k.real_tokens,
      k.amm_quote, k.amm_tokens, k.status
    FROM trades t JOIN tokens k ON k.mint = t.mint
    WHERE t.slot IS NOT NULL AND t.slot >= ? AND t.slot <= ?
    ORDER BY t.slot ASC, t.id ASC LIMIT 5000`).all(fromBlock, hi);

  const out = [];
  for (const r of rows) {
    const quoteMint = quoteMintOf({ quote_mint: r.quote_mint, quote: r.quote_symbol });
    if (!quoteMint) continue;
    const { tokenIs0 } = sides(r.mint, quoteMint);
    const tokens = Math.abs(Number(r.tokens) || 0);
    const quote = Math.abs(Number(r.quote) || 0);
    if (!(tokens > 0) || !(quote > 0)) continue;

    // price of asset0 denominated in asset1
    const priceNative = tokenIs0 ? quote / tokens : tokens / quote;
    // Reserves are what backs the price. After graduation that is the AMM's, before it the curve's.
    const grad = String(r.status) === 'graduated';
    const resToken = grad ? Number(r.amm_tokens) : Number(r.real_tokens);
    const resQuote = grad ? Number(r.amm_quote) : Number(r.real_quote);

    const buy = r.side === 'buy';
    const legs = tokenIs0
      ? (buy ? { asset1In: String(quote), asset0Out: String(tokens) } : { asset0In: String(tokens), asset1Out: String(quote) })
      : (buy ? { asset0In: String(quote), asset1Out: String(tokens) } : { asset1In: String(tokens), asset0Out: String(quote) });

    out.push({
      block: { blockNumber: Number(r.slot), blockTimestamp: Math.floor(Number(r.ts) / 1000) },
      eventType: 'swap',
      txnId: r.sig || String(r.id),
      txnIndex: 0,
      eventIndex: Number(r.id),
      maker: r.wallet,
      pairId: r.mint,
      priceNative: String(priceNative),
      ...legs,
      reserves: {
        asset0: String(tokenIs0 ? resToken : resQuote),
        asset1: String(tokenIs0 ? resQuote : resToken),
      },
    });
  }
  return { events: out };
}
