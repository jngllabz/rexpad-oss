// Swap indexer for coins living on Meteora's Dynamic Bonding Curve.
//
// ⛔ WHY THIS EXISTS. Nothing else on this site ever sees a DBC swap. Our own `trades` table is
// written by our own curve program, so a coin on the `dbc` venue showed 0 trades, $0 volume and 0
// holders for ever — $BITE read exactly that while it had genuinely traded over 300 times, held
// 12.8M REX and been called at $10.7K. DexScreener is no substitute: it counts the transactions on
// these pools and returns null for price, volume and liquidity, because the pair is quoted in $REX.
//
// The approach is deliberately NOT event-log decoding. A swap's effect is visible in the
// transaction's own pre/post token balances, which every RPC returns and which cannot drift out of
// sync with a program upgrade or an IDL change. We read the pool's two vaults, take the deltas, and
// that is the trade: quote in and base out is a buy, the reverse is a sell. Anything that moves
// neither vault is not a swap and is skipped, which is how pool creation, fee claims and migrations
// stay out of the tape.
import { PublicKey } from '@solana/web3.js';
import { db } from './db.mjs';
import { warn } from './config.mjs';
import * as ENG from './engine.mjs';

// How much history to walk per pass, sized to the endpoint actually in use.
//
// On the free public RPC this has to crawl: a burst of getTransaction calls is rate-limited into
// failure, so a pool catches up over several passes and a backfill takes minutes. A paid endpoint
// has no such ceiling, and a backfill that takes minutes is the difference between a board that is
// current and one that is visibly behind the trading. Read per call rather than captured at import,
// so changing the secret takes effect on the next pass instead of the next deploy.
function budget(CH) {
  return CH.isPublicRpc() ? { page: 40, tx: 25 } : { page: 200, tx: 150 };
}

/** Remember where each pool was last read, so a pass only ever walks what is new. */
function lastSig(mint) {
  try { return db.prepare('SELECT dbc_last_sig v FROM tokens WHERE mint=?').get(mint)?.v || null; }
  catch { return null; }
}
const setLastSig = (mint, sig) => { try { db.prepare('UPDATE tokens SET dbc_last_sig=? WHERE mint=?').run(sig, mint); } catch (e) { warn('dbc last sig', e.message); } };

/**
 * The pool's own token accounts, so a balance change can be attributed to the pool rather than to
 * whoever happened to be in the transaction. Read from the pool state, never assumed.
 */
async function vaultsOf(conn, pool, MET) {
  const c = await MET.client(conn);
  const st = (await c.state.getPool(new PublicKey(pool)))?.poolState;
  if (!st) return null;
  return {
    base: st.baseVault?.toBase58?.() || null,
    quote: st.quoteVault?.toBase58?.() || null,
    baseMint: st.baseMint?.toBase58?.() || null,
    quoteMint: st.quoteMint?.toBase58?.() || null,
  };
}

/** A balance map keyed by account address, from one side of a transaction. */
const byAccount = (list, keys) => {
  const out = new Map();
  for (const b of list || []) {
    const addr = keys[b.accountIndex];
    if (addr) out.set(addr, Number(b.uiTokenAmount?.uiAmount ?? 0));
  }
  return out;
};

/**
 * Turn one confirmed transaction into a trade, or null when it is not one.
 *
 * ⛔ The SIGN of the quote delta decides the side, from the POOL's point of view: quote flowing
 * INTO the pool is somebody buying. Taking it from the trader's side instead would invert every
 * sell, and nothing downstream would notice because both are plausible numbers.
 */
function tradeFromTx(tx, vaults) {
  const meta = tx?.meta; if (!meta || meta.err) return null;
  // ⛔ A VERSIONED MESSAGE EXPOSES `staticAccountKeys`, NOT `accountKeys`, and any address it pulled
  // from a lookup table is not in there at all — it arrives separately in meta.loadedAddresses.
  // Reading only `accountKeys` yields an EMPTY list on these transactions, every token balance maps
  // to undefined, and the indexer concludes a busy pool has never traded. The order is load-bearing:
  // static keys, then loaded writable, then loaded readonly, because accountIndex indexes that
  // concatenation.
  const msg = tx.transaction?.message || {};
  const b58 = (k) => (typeof k === 'string' ? k : k?.toBase58?.() ?? k?.pubkey ?? String(k));
  const keys = [
    ...(msg.staticAccountKeys || msg.accountKeys || []).map(b58),
    ...(meta.loadedAddresses?.writable || []).map(b58),
    ...(meta.loadedAddresses?.readonly || []).map(b58),
  ];
  const pre = byAccount(meta.preTokenBalances, keys), post = byAccount(meta.postTokenBalances, keys);
  const dq = (post.get(vaults.quote) ?? 0) - (pre.get(vaults.quote) ?? 0);
  const dbase = (post.get(vaults.base) ?? 0) - (pre.get(vaults.base) ?? 0);
  // A swap moves both vaults in opposite directions. Anything else — creating the pool, claiming a
  // fee, migrating — is not a trade and must not reach the tape.
  if (!dq || !dbase) return null;
  if (Math.sign(dq) === Math.sign(dbase)) return null;
  const side = dq > 0 ? 'buy' : 'sell';
  const quote = Math.abs(dq), tokens = Math.abs(dbase);
  if (!(quote > 0) || !(tokens > 0)) return null;
  return {
    side, quote, tokens,
    price: quote / tokens,
    wallet: keys[0] || '',                       // the fee payer is the trader on a plain swap
    ts: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
  };
}

/**
 * Walk one pool's new signatures and write any swaps found.
 * Returns how many trades were recorded.
 */
export async function indexPool(conn, t, MET, CH) {
  const { page: PAGE, tx: TX_PER_PASS } = budget(CH);
  const vaults = await vaultsOf(conn, t.dbc_pool, MET);
  if (!vaults?.quote || !vaults?.base) return 0;

  // Two walks share one pass. FORWARD picks up what is new since last time; BACKWARD fills in the
  // history behind the first page we ever saw, because signatures are only reachable newest-first
  // and a pool that has already traded 300 times would otherwise start life with 40 of them.
  const row = db.prepare('SELECT dbc_last_sig, dbc_back_sig, dbc_backfilled FROM tokens WHERE mint=?').get(t.mint) || {};
  const until = row.dbc_last_sig || null;
  let sigs = [];
  try {
    const fwd = await conn.getSignaturesForAddress(new PublicKey(t.dbc_pool), until ? { until, limit: PAGE } : { limit: PAGE }, 'confirmed');
    sigs = fwd || [];
    if (!row.dbc_backfilled) {
      const before = row.dbc_back_sig || (sigs.length ? sigs[sigs.length - 1].signature : null);
      const back = before ? await conn.getSignaturesForAddress(new PublicKey(t.dbc_pool), { before, limit: PAGE }, 'confirmed') : [];
      if (back?.length) {
        sigs = sigs.concat(back);
        db.prepare('UPDATE tokens SET dbc_back_sig=? WHERE mint=?').run(back[back.length - 1].signature, t.mint);
      } else {
        // Nothing older left: the walk has reached the pool's first transaction.
        db.prepare('UPDATE tokens SET dbc_backfilled=1 WHERE mint=?').run(t.mint);
      }
    }
  } catch (e) { warn('dbc sigs', e.message); return 0; }
  if (!sigs.length) return 0;

  // Oldest first, so the tape reads forward and a crash mid-pass resumes from the right place.
  const fresh = sigs.filter((s) => !s.err).reverse().slice(0, TX_PER_PASS);
  const ins = db.prepare('INSERT INTO trades(mint,wallet,side,quote,tokens,price,fee,tax,kind,ts) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const seen = db.prepare('SELECT 1 FROM trades WHERE mint=? AND ts=? AND wallet=? AND quote=?');
  // ⛔ The forward cursor may only advance to the newest signature overall. Setting it from a
  // backfilled (older) page would move it BACKWARDS and re-walk the same history for ever.
  const newest = sigs.reduce((a, b) => (!a || (b.slot ?? 0) > (a.slot ?? 0) ? b : a), null)?.signature || null;
  let n = 0;
  for (const s of fresh) {
    let tx;
    // ⛔ THESE ARE VERSION 1 TRANSACTIONS. Asking for 0 makes the RPC refuse every single one with
    // "Transaction version (1) is not supported by the requesting client" — the indexer then walks
    // the whole history, finds nothing, and reports zero trades as though the pool were idle.
    try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }); }
    catch (e) { warn('dbc tx', e.message); continue; }
    const tr = tradeFromTx(tx, vaults);
    if (!tr) continue;
    // Cheap idempotence: the same pass re-running must not double-count volume.
    if (seen.get(t.mint, tr.ts, tr.wallet, tr.quote)) continue;
    ins.run(t.mint, tr.wallet, tr.side, tr.quote, tr.tokens, tr.price, 0, 0, 'dbc', tr.ts);
    // ⛔ ATTRIBUTE THE BUY TO WHOEVER SENT THEM. Share-and-earn divides `ref_credit.volume`, and
    // the only caller of this was the paper curve's buy() — so on the venue every real coin trades
    // on, a sharer's link worked, the buyer arrived, and nothing recorded that they had brought
    // them. Elio calls this feature our moat; it had never recorded a single trade.
    if (tr.side === 'buy') {
      try { ENG.creditReferral(t.mint, tr.wallet, tr.quote); }
      catch (e) { warn('dbc referral', e.message); }   // never let attribution break the tape
    }
    // ⛔ A TRADE THAT NEVER REACHES THE CANDLE TABLE IS A COIN WITH A TAPE AND NO CHART.
    // Candles are written by our own curve's buy/sell, which a Meteora swap never goes through, so
    // without this the site could list every trade and still draw nothing — which is why these
    // coins were falling back to a third party's iframe for a chart we can neither style nor trust.
    const candle = (() => { try { return ENG.pushCandle(t.mint, tr.price, tr.quote, tr.ts); } catch (e) { warn('dbc candle', e.message); return null; } })();
    // ⛔ AND TELL THE OPEN PAGES. A Meteora swap never passes through our own buy/sell, which is
    // what pushes onto the event queue — so these trades were being stored and charted and NEVER
    // broadcast. Every board on the site updates from that queue, so they all sat frozen on
    // whatever was true when the tab loaded. Same shape as an engine trade, so every existing
    // listener works unchanged.
    ENG.events.push({
      type: 'trade', mint: t.mint, wallet: tr.wallet, side: tr.side,
      quote: tr.quote, tokens: tr.tokens, price: tr.price, fee: 0, tax: 0,
      kind: 'dbc', ts: tr.ts, symbol: t.symbol, name: t.name, image: t.image,
      quoteSymbol: t.quote, candle,
    });
    n++;
  }
  if (newest) setLastSig(t.mint, newest);
  if (n) {
    // Roll the token's own counters off the tape itself, so they can never disagree with it.
    const agg = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(quote),0) v, MAX(ts) last FROM trades WHERE mint=?").get(t.mint);
    const vol24 = db.prepare("SELECT COALESCE(SUM(quote),0) v FROM trades WHERE mint=? AND ts > ?").get(t.mint, Date.now() - 86_400_000)?.v || 0;
    // ⛔ SET THE PRICE FROM THE TRADE, because an execution is the best price there is and this one
    // cost no RPC at all. Until now only the pool sweep wrote `tokens.price`, so a coin's displayed
    // price was only ever as fresh as the last time we asked the chain — which is what forced that
    // sweep to poll every active pool every ten seconds and is most of what exhausted the RPC plan.
    //
    // Units checked rather than assumed, because this codebase has had a thousand-fold price bug
    // from exactly this: `byAccount` reads `uiTokenAmount.uiAmount`, so `quote` and `tokens` here
    // are DECIMAL-ADJUSTED, and `price = quote / tokens` is UI-quote per UI-base — the same unit
    // poolStatsOf produces with `sp * sp * 10 ** (baseDecimals - quoteDecimals)`. If either side
    // were raw these would differ by 10^(base-quote) and every board figure would be wrong.
    const latest = db.prepare('SELECT price FROM trades WHERE mint=? ORDER BY ts DESC, rowid DESC LIMIT 1').get(t.mint);
    if (latest && Number(latest.price) > 0) {
      db.prepare('UPDATE tokens SET trades=?, volume=?, last_trade_at=?, price=? WHERE mint=?')
        .run(agg.c, vol24, agg.last, Number(latest.price), t.mint);
    } else {
      db.prepare('UPDATE tokens SET trades=?, volume=?, last_trade_at=? WHERE mint=?').run(agg.c, vol24, agg.last, t.mint);
    }
  }
  return n;
}

/**
 * How many wallets hold the coin, counted from the token program.
 *
 * ⛔ Counting distinct traders from the tape would be wrong: tokens move by transfer and by airdrop,
 * holders sell out entirely, and the pool's own vault is not a holder. The token program is the only
 * place that knows. `dataSlice` keeps the response small — we need the amount at offset 64, nothing
 * else — because the full accounts for a busy mint are megabytes.
 */
export async function countHolders(conn, mint, excludeOwners = []) {
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  let total = 0, any = false;
  for (const [prog, size] of [[TOKEN, 165], [T22, null]]) {
    try {
      const accs = await conn.getProgramAccounts(prog, {
        commitment: 'confirmed',
        // offset 0 is the mint; offset 64 is the u64 amount.
        dataSlice: { offset: 64, length: 8 },
        filters: [...(size ? [{ dataSize: size }] : []), { memcmp: { offset: 0, bytes: mint } }],
      });
      any = true;
      for (const a of accs) {
        const b = a.account?.data;
        if (!b || b.length < 8) continue;
        if (Buffer.from(b).readBigUInt64LE(0) > 0n) total++;
      }
    } catch (e) { warn('dbc holders', e.message); }
  }
  // An RPC that refused must leave the figure alone rather than reporting nobody holds it.
  return any ? Math.max(0, total - excludeOwners.length) : null;
}

/**
 * The actual holder list for a Meteora coin, read from the token program.
 *
 * ⛔ `holdersOf` in the engine reads our own `holdings` table, which is written by our own curve
 * program and is therefore EMPTY for a dbc coin — the Holders tab rendered its headers and not one
 * row while the coin had 24 real holders. The count and the list have to come from the same place
 * or they contradict each other on screen.
 *
 * `dataSlice` takes owner (offset 32, 32 bytes) and amount (offset 64, 8 bytes) in one 40-byte
 * window, so a mint with thousands of accounts still answers in kilobytes rather than megabytes.
 */
const TOKEN_PROGRAMS = [
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 165],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', null],
];
const _holders = new Map();   // mint -> { at, rows }

/**
 * ⛔ A CALLER THAT DELETES ROWS NEEDS TO KNOW WHETHER THIS ANSWER IS FRESH.
 *
 * Serving a cached list when the chain refuses is right for a page — a slightly old holder table
 * beats an empty one. It is catastrophic for the mirror, which DELETES anyone the list does not
 * mention: a rate limit, a stale empty cache, and every holder of that coin is zeroed, including
 * in the table the reward epoch reads. Found by a test that posed exactly that pair of conditions.
 *
 * So the freshness is reported alongside the rows. `holdersFresh(mint)` is true only when the last
 * answer came from a scan the chain actually completed, in this call.
 */
const _freshAt = new Map();
export const holdersFresh = (mint) => _freshAt.get(String(mint)) === 'fresh';
export async function holdersFromChain(conn, mint, { limit = 50, exclude = [], ttlMs = 120_000 } = {}) {
  const hit = _holders.get(mint);
  if (hit && Date.now() - hit.at < ttlMs) { _freshAt.set(String(mint), 'cached'); return hit.rows.slice(0, limit); }
  _freshAt.set(String(mint), 'pending');
  // ⛔ EXCLUDE BY ACCOUNT ADDRESS, NOT BY OWNER. The pool's base vault holds every token that has
  // not been sold off the curve — 80.1% of $BITE's supply — and its owner is a program PDA. Merging
  // by owner without dropping the vault account first puts the curve itself at the top of the
  // holders table as an 80% whale, which is both wrong and alarming to anyone reading it.
  const skip = new Set(exclude.filter(Boolean));
  const rows = [];
  let answered = false;
  for (const [prog, size] of TOKEN_PROGRAMS) {
    try {
      const accs = await conn.getProgramAccounts(new PublicKey(prog), {
        commitment: 'confirmed',
        dataSlice: { offset: 32, length: 40 },
        filters: [...(size ? [{ dataSize: size }] : []), { memcmp: { offset: 0, bytes: mint } }],
      });
      answered = true;
      for (const a of accs) {
        const b = Buffer.from(a.account?.data || []);
        if (b.length < 40) continue;
        const addr = a.pubkey?.toBase58?.() || String(a.pubkey);
        const owner = new PublicKey(b.subarray(0, 32)).toBase58();
        const amount = b.readBigUInt64LE(32);
        if (amount <= 0n || skip.has(addr) || skip.has(owner)) continue;
        rows.push({ wallet: owner, raw: amount });
      }
    } catch (e) { warn('dbc holder list', e.message); }
  }
  // An RPC that refused must not be rendered as "nobody holds this".
  if (!answered) { _freshAt.set(String(mint), 'cached'); return hit ? hit.rows.slice(0, limit) : null; }
  _freshAt.set(String(mint), 'fresh');
  // One owner can hold the same mint in several accounts; the holder is the owner, not the account.
  const merged = new Map();
  for (const r of rows) merged.set(r.wallet, (merged.get(r.wallet) || 0n) + r.raw);
  const out = [...merged.entries()]
    .map(([wallet, raw]) => ({ wallet, amount: Number(raw) / 1e6 }))
    .sort((a, b) => b.amount - a.amount);
  _holders.set(mint, { at: Date.now(), rows: out });
  return out.slice(0, limit);
}

/**
 * Build candles from trades already in the table.
 *
 * ⛔ THE INDEXER ONLY WRITES A CANDLE WHEN IT DISCOVERS A TRADE, so a pool whose history was walked
 * BEFORE candle-writing existed has a full trade tape and an empty chart — and once `dbc_backfilled`
 * is set it never walks that history again to fix it. $BITE had 61 indexed trades and drew nothing.
 * Trades are the source of truth either way, so the candles can simply be rebuilt from them.
 *
 * Idempotent and cheap: it does nothing unless a coin has trades and no candles at all.
 */
export function backfillCandles(mint, ENGINE = ENG) {
  // ⛔ ONLY FILL WHAT PREDATES THE EARLIEST CANDLE. `pushCandle` ADDS volume to an existing bucket,
  // so replaying a trade that already has one double-counts it. The first version of this skipped
  // whenever ANY candle existed — and a single candle written by one newly-indexed trade was enough
  // to block the rebuild of all 61 trades behind it, leaving the chart with one bar.
  const firstCandle = db.prepare('SELECT MIN(ts) t FROM candles WHERE mint=?').get(mint)?.t ?? null;
  const rows = firstCandle === null
    ? db.prepare('SELECT price, quote, ts FROM trades WHERE mint=? ORDER BY ts ASC').all(mint)
    : db.prepare('SELECT price, quote, ts FROM trades WHERE mint=? AND ts < ? ORDER BY ts ASC').all(mint, firstCandle);
  if (!rows.length) return 0;
  for (const r of rows) {
    try { ENGINE.pushCandle(mint, r.price, r.quote, r.ts); } catch (e) { warn('candle backfill', e.message); }
  }
  return rows.length;
}

/**
 * Mirror a Meteora coin's REAL holders into our own `holdings` table.
 *
 * ⛔ WITHOUT THIS, A DBC COIN CAN NEVER PAY ITS HOLDERS. `runEpoch` asks `rewardSnapshot` who is
 * eligible, and that reads `holdings` — a table written only by our own curve program, and so empty
 * for every Meteora launch. The snapshot therefore found nobody, `payHolders` was false every time,
 * and the epoch counter stayed at 0 for ever: $BITE had 56,566 REX of holder money sitting in
 * `yield_pool` with 16 real holders on chain and not one epoch ever paid. The Holders TAB already
 * read the chain directly (`holdersFromChain`) — so the site could show you the holders it was
 * refusing to pay.
 *
 * `held_since` is stamped the first time we see a wallet holding and never moved while it keeps
 * holding, which is what the conviction multiplier reads. That clock starts when REX Chain first
 * saw the position, not when it was opened on chain — honest, and the only thing available without
 * walking every historical transfer. Selling to zero clears the row, so buying back starts it again,
 * which is exactly the rule our own curve applies.
 */
export async function mirrorHolders(conn, t, MET) {
  const vaults = t.dbc_pool ? await MET.poolVaultsOf(conn, t.dbc_pool).catch(() => null) : null;
  // No limit: a payout must see EVERY holder, not the top 50 the UI shows.
  const rows = await holdersFromChain(conn, t.mint, {
    limit: 100_000, ttlMs: 0, exclude: [vaults?.base, vaults?.quote],
  });
  // ⛔ NULL AND EMPTY ARE DIFFERENT ANSWERS AND THIS TREATED THEM THE SAME.
  //
  // holdersFromChain returns null when the scan was REFUSED and [] when it genuinely found nobody.
  // `if (!rows?.length) return 0` bailed on both — so a coin everybody had sold out of kept every
  // one of its holders on the books for ever, because the one run that would have cleared them is
  // the run that returns an empty list.
  //
  // Null still bails: clearing every holder on a refused RPC would wipe real positions, and those
  // positions decide who gets paid.
  if (!rows) return 0;
  // ⛔ AND ONLY A FRESH SCAN MAY DELETE. A refused scan can still hand back a cached list, and if
  // that cache happens to be empty this would zero every holder of the coin over a rate limit.
  if (!holdersFresh(t.mint)) return rows.length;
  const now = Date.now();
  const seen = new Set();
  const get = db.prepare('SELECT amount, held_since FROM holdings WHERE wallet=? AND mint=?');
  const up = db.prepare(`INSERT INTO holdings(wallet,mint,amount,held_since) VALUES(?,?,?,?)
                         ON CONFLICT(wallet,mint) DO UPDATE SET amount=excluded.amount`);
  for (const h of rows) {
    if (!h.wallet || !(h.amount > 0)) continue;
    seen.add(h.wallet);
    const prev = get.get(h.wallet, t.mint);
    up.run(h.wallet, t.mint, h.amount, prev?.held_since || now);
  }
  // Anyone who no longer holds is zeroed rather than left at a stale balance — a wallet that sold
  // must stop earning, and leaving the row would pay it for ever on a position it does not have.
  let cleared = 0;
  for (const r of db.prepare('SELECT wallet FROM holdings WHERE mint=? AND amount > 0').all(t.mint)) {
    if (!seen.has(r.wallet)) {
      db.prepare('UPDATE holdings SET amount=0, held_since=NULL WHERE wallet=? AND mint=?').run(r.wallet, t.mint);
      cleared++;
    }
  }
  return rows.length;
}
