// Indexer: turns REX Chain program accounts into the same token rows the UI already reads, so the
// discover grid, charts, holders and leaderboards work identically on-chain and in demo mode.
// Two feeds: a poll that reconciles account state, and a log subscription that decodes program
// events in real time for the trade tape and candles.
import anchor from '@coral-xyz/anchor';
import { db, tx, meta as kv } from './db.mjs';
import { cfg, log, warn } from './config.mjs';
import { QUOTES, usdOf } from './prices.mjs';
import * as CH from './chain.mjs';
import * as E from './engine.mjs';
import { MODES as AI_MODES } from './ai_alloc.mjs';

// The LAUNCHED token is always 6 decimals — the program mints it. The QUOTE is whatever its own mint
// says, and it is not always 6: Zcash is 8 on Solana, Monero is 12, every xStock is 8. Scaling both
// sides by 1e6, which is what this did, would have reported a ZEC-quoted launch 100x out and an
// XMR-quoted one by a million — in the market cap, the reward pot, the volume and the payout maths.
// Hence two converters, and a quote one that has to be told which mint it is converting.
const TOKEN_DEC = 1e6;
const ut = (base) => Number(base) / TOKEN_DEC;                       // the launched token
const QUOTE_BY_MINT = Object.fromEntries(Object.values(QUOTES).map((q) => [q.mint, q.symbol]));
const QUOTE_DEC_BY_MINT = Object.fromEntries(Object.values(QUOTES).map((q) => [q.mint, 10 ** (q.decimals ?? 6)]));
const quoteSymbol = (mint) => QUOTE_BY_MINT[mint] || mint.slice(0, 4);
const MINT_BY_QUOTE = Object.fromEntries(Object.values(QUOTES).map((q) => [q.symbol, q.mint]));
const mintOfQuoteSymbol = (sym) => MINT_BY_QUOTE[sym] || '';
/**
 * Which mint a launch is quoted in — log events only carry the launch, so it comes from what we
 * indexed. The stored MINT is authoritative; the symbol lookup is only a fallback for rows written
 * before quote_mint existed. Going through the symbol is lossy: `quoteSymbol` degrades an
 * unrecognised quote to the mint's first four characters, and that cannot be resolved back, so the
 * amounts would silently be scaled by the wrong number of decimals.
 */
const quoteMintOf = (mint) => {
  const r = db.prepare('SELECT quote, quote_mint FROM tokens WHERE mint=?').get(mint);
  return r?.quote_mint || mintOfQuoteSymbol(r?.quote || '');
};
/** Base units → display units for a quote-denominated amount on a launch quoted in `quoteMint`. */
const uq = (base, quoteMint) => Number(base) / (QUOTE_DEC_BY_MINT[String(quoteMint)] ?? TOKEN_DEC);

const getMeta = db.prepare('SELECT * FROM token_meta WHERE mint=?');
export const saveMeta = (m) => db.prepare(`INSERT INTO token_meta(mint,name,symbol,description,image,website,twitter,telegram,creator,created_at,reward_mode)
  VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, description=excluded.description,
  image=excluded.image, website=excluded.website, twitter=excluded.twitter, telegram=excluded.telegram`)
  .run(m.mint, m.name, m.symbol, m.description || '', m.image || null, m.website || null, m.twitter || null, m.telegram || null, m.creator, Date.now(),
    E.rewardMode(m.rewardMode));
// NOTE: reward_mode is deliberately ABSENT from the DO UPDATE SET above. This row is written before
// the create tx is signed, so there is no on-chain creator to authenticate against yet and a second
// call for the same mint is not proven to come from the launcher. Everything in that SET list is
// therefore overwritable by a later call — which is survivable for a name or an image, and is not
// survivable for the rule that decides who gets paid what. Set once, at launch, and never after.

/**
 * Record a launch that lives on Meteora rather than on our own curve.
 *
 * Written only after its pool has been seen on chain, so an abandoned wallet prompt cannot leave a
 * phantom coin in the list. `venue` is stored rather than inferred — two venues run side by side
 * while the old launches finish, and guessing one from the shape of a row is how a swap ends up
 * addressed to the wrong program.
 */
export function saveDbcLaunch({ mint, pool, config, creator, name, symbol, image, description,
  website, twitter, telegram, quote, quoteMint, poolFeeBps, creatorSharePct,
  holderBps, vaultBps, burnBps, buybackBps, rewardMode, hookProgram = null, venue = 'dbc',
  refShareBps = 0 }) {
  // ⛔ SHARE & EARN WAS BEING DROPPED ON THE FLOOR AT LAUNCH. The form collects it (Off/25/50/75/
  // 100%), the old paper-curve path stored it, and this one — the path every coin has taken since
  // the venue moved to Meteora — did not even take it as an argument. So every live coin read back
  // ref_share_bps = 0 and its share panel said "this coin has no creator cut, so there is nothing
  // to pay a sharer out of yet", to launchers who had just chosen 25%. Elio reported it twice and
  // called it our moat.
  // ⛔ `dbc_pool` HOLDS THE VENUE'S POOL, whichever venue that is. The column predates there being
  // more than one; `venue` is what tells them apart, and every reader already branches on it.
  if (venue !== 'dbc' && venue !== 'launchlab') throw new Error(`unknown venue ${venue}`);
  const now = Date.now();
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  // The four buckets describe how REX Chain's share of the CLAIMED pool fee is divided. They are
  // shares of that claim, so they are capped at the whole and whatever is left over is REX's.
  const h = clamp(holderBps, 0, 10_000, 5000), v = clamp(vaultBps, 0, 10_000, 0);
  const b = clamp(burnBps, 0, 10_000, 0), k = clamp(buybackBps, 0, 10_000, 0);
  db.prepare(`INSERT INTO tokens(mint,name,symbol,description,image,website,twitter,telegram,creator,quote,quote_mint,
      venue,dbc_pool,dbc_config,pool_fee_bps,creator_share_pct,holder_bps,vault_bps,burn_bps,buyback_bps,reward_mode,ref_share_bps,
      status,created_at,opened_at,price,hook_program)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live',?,?,0,?)
    -- ⛔ hook_program is re-stamped on conflict, and it comes from the MINT rather than the form.
    -- It is the one field a dishonest launcher has a motive to leave out, and a coin that can
    -- refuse a sell must never be able to present itself as one that cannot.
    ON CONFLICT(mint) DO UPDATE SET dbc_pool=excluded.dbc_pool, dbc_config=excluded.dbc_config,
      hook_program=COALESCE(excluded.hook_program, tokens.hook_program),
      name=excluded.name, symbol=excluded.symbol, ref_share_bps=excluded.ref_share_bps,
      -- Keep the artwork already on the row when this call brings none, so a failed or missing
      -- upload here can never blank an image that /api/chain/meta stored correctly.
      image=COALESCE(excluded.image, tokens.image)`)
    .run(mint, E.cleanText ? E.cleanText(name, 32) : String(name || '').slice(0, 32),
      String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
      String(description || '').slice(0, 600), image || null,
      website || null, twitter || null, telegram || null, creator,
      quote || quoteSymbol(quoteMint), quoteMint || null,
      venue,
      pool, config || null,
      clamp(poolFeeBps, 10, 5000, cfg.poolFeeBps), clamp(creatorSharePct, 0, 100, cfg.creatorSharePct),
      h, v, b, k, E.rewardMode(rewardMode),
      // Capped the same way the old path capped it, so the two venues cannot disagree about the
      // ceiling a launcher is allowed to give away.
      Math.max(0, Math.min(10_000, Math.round(Number(refShareBps) || 0))),
      now, now, hookProgram || null);
  // The program the launcher picked: how fees are allocated, who is eligible and in what asset.
  // Written through a whitelist each — a launch form is a stranger's input, and `payout_rule` in
  // particular decides who gets paid at all.
  const o = arguments[0] || {};
  const RULES = ['all', 'whale', 'shrimp', 'equal'];
  // ⛔ THE WHITELIST IS THE MODE LIST ITSELF, not a copy of it. A second list here is a list that
  // keeps accepting 'manager' and 'dip' after they are gone, and a stored mode nothing implements
  // is how this whole family of bugs starts.
  const AI = AI_MODES;
  // ⛔ THIS RUNS AFTER THE POOL EXISTS ON CHAIN, so it must not throw. Both callers are the
  // dbc/confirm path: the coin is already live and already costing its creator money by the time
  // we get here, and refusing to record it would leave a real pool with no row behind it — a
  // worse outcome than any basket problem. The basket is validated at /api/chain/meta, BEFORE
  // anything is signed, which is where a creator can still do something about it. Reaching here
  // with a bad one means something went round that check, so record the coin, store no basket —
  // which reads honestly everywhere as "pays in its quote" — and say so loudly in the log.
  const basket = E.normalizeBasket(o.payoutAssets);
  if (basket.error) warn('⛔ launch', symbol, mint.slice(0, 6), 'had an unusable payout basket —', basket.error, '— recorded with none');
  db.prepare('UPDATE tokens SET ai_mode=?, payout_rule=?, payout_n=?, payout_assets=? WHERE mint=?')
    .run(AI.includes(o.aiMode) ? o.aiMode : 'off',
      RULES.includes(o.payoutRule) ? o.payoutRule : 'all',
      Math.max(1, Math.min(10_000, Math.round(Number(o.payoutN) || 25))),
      basket.json,
      mint);
  log('🌊 dbc launch', symbol, mint.slice(0, 6), 'pool', String(pool).slice(0, 8));
  return db.prepare('SELECT * FROM tokens WHERE mint=?').get(mint);
}

/**
 * Pull live state for every Meteora launch into the rows the UI reads.
 *
 * Reads reserves and the accrued fee straight off the pool. Price comes from the pool's own
 * reserves rather than from anything we computed, because the pool is now the authority on price —
 * our curve maths no longer has anything to do with it.
 */
/*
 * syncDbc lived here and is deleted rather than kept working.
 *
 * It wrote tokens.price from the ratio of a pool's reserves, divided by 1e6 on both sides. Two
 * defects: a nine-decimal quote came out a thousand times high, and on a BONDING CURVE the reserve
 * ratio is the average price of everything traded so far rather than the price of the next token.
 *
 * ⛔ IT HAD NO CALLERS. The price is written by the tiered pool loop in server.mjs, which uses
 * poolStatsOf — sqrtPrice, both decimals, correct. So this was never live, and the market caps on
 * the board were right all along; I briefly believed otherwise by comparing `mcap`, which is
 * denominated in the QUOTE asset, against a dollar figure.
 *
 * Fixing dead code and leaving it is the worse option: the next person to need a DBC sync finds a
 * function that looks ready and is a second, divergent answer to a question that already has one.
 */

/** Map one on-chain Launch onto the tokens row the UI reads. */
function upsertLaunch(l) {
  const meta = getMeta.get(l.mint) || {};
  const qm = String(l.quoteMint);
  const quote = quoteSymbol(qm);
  const status = l.status === 'fairopen' ? 'fairopen' : l.status === 'graduated' ? 'graduated' : 'live';
  // Price is quote-per-token, so both sides have to be in display units before dividing.
  const price = status === 'graduated'
    ? (l.ammToken > 0 ? uq(l.ammQuote, qm) / ut(l.ammToken) : 0)
    : (l.vToken > 0 ? uq(l.vQuote, qm) / ut(l.vToken) : 0);
  const existing = db.prepare('SELECT created_at, trades, volume, yield_paid, yield_payouts FROM tokens WHERE mint=?').get(l.mint);
  // Bidders and the clearing price come from the fills we recorded, not from the launch account —
  // the program keeps no bidder count, and these two were previously hardcoded to 0 on chain, which
  // is what made a settled Fair Open look like one nobody had turned up to.
  const fo = db.prepare("SELECT COUNT(*) n, MAX(price) price FROM trades WHERE mint=? AND kind='fairopen'").get(l.mint) || {};
  const now = Date.now();
  db.prepare(`INSERT INTO tokens(mint,name,symbol,description,image,website,twitter,telegram,creator,quote,quote_mint,tax_bps,holder_bps,creator_bps,vault_bps,burn_bps,rex_bps,reward_mode,creator_pot,vault_pot,burn_pot,rex_pot,fair_open_secs,fair_open_ends,status,
      v_quote,v_tokens,real_quote,real_tokens,k,raise_target,amm_quote,amm_tokens,yield_pool,yield_paid,yield_payouts,yield_epochs,
      fair_open_total,fair_open_bidders,fair_open_price,created_at,opened_at,graduated_at,last_trade_at,price,trades,holders,volume,dev_locked)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT(mint) DO UPDATE SET name=excluded.name, symbol=excluded.symbol, description=excluded.description, image=excluded.image,
      website=excluded.website, twitter=excluded.twitter, telegram=excluded.telegram, quote=excluded.quote, quote_mint=excluded.quote_mint, tax_bps=excluded.tax_bps,
      holder_bps=excluded.holder_bps, creator_bps=excluded.creator_bps, vault_bps=excluded.vault_bps, burn_bps=excluded.burn_bps, rex_bps=excluded.rex_bps,
      creator_pot=excluded.creator_pot, vault_pot=excluded.vault_pot, burn_pot=excluded.burn_pot, rex_pot=excluded.rex_pot,
      fair_open_ends=excluded.fair_open_ends, status=excluded.status, v_quote=excluded.v_quote, v_tokens=excluded.v_tokens,
      real_quote=excluded.real_quote, real_tokens=excluded.real_tokens, raise_target=excluded.raise_target, amm_quote=excluded.amm_quote,
      amm_tokens=excluded.amm_tokens, yield_pool=excluded.yield_pool, yield_epochs=excluded.yield_epochs,
      fair_open_total=excluded.fair_open_total, fair_open_bidders=excluded.fair_open_bidders,
      fair_open_price=excluded.fair_open_price, price=excluded.price, holders=excluded.holders`)
    .run(l.mint, meta.name || l.mint.slice(0, 6), meta.symbol || l.mint.slice(0, 4).toUpperCase(), meta.description || '', meta.image || null,
      meta.website || null, meta.twitter || null, meta.telegram || null, l.creator, quote, qm, l.totalFeeBps,
      l.holderBps, l.creatorBps, l.vaultBps, l.burnBps, l.rexBps,
      // Chosen by the launcher before the create tx was signed; set once and never updated below.
      E.rewardMode(meta.reward_mode),
      uq(l.creatorPot, qm), uq(l.vaultPot, qm), uq(l.burnPot, qm), uq(l.rexPot, qm),
      l.fairOpenEnds ? Math.max(0, Math.round((l.fairOpenEnds - (meta.created_at || l.fairOpenEnds)) / 1000)) : 0,
      l.fairOpenEnds, status,
      uq(l.vQuote, qm), ut(l.vToken), uq(l.realQuote, qm), ut(l.realToken), uq(l.vQuote, qm) * ut(l.vToken), uq(l.raiseTarget, qm),
      uq(l.ammQuote, qm), ut(l.ammToken), uq(l.rewardPot, qm), existing?.yield_paid || 0, existing?.yield_payouts || 0, l.epochCount,
      uq(l.fairOpenTotal, qm), fo.n || 0, fo.price || 0,
      existing?.created_at || meta.created_at || now, meta.created_at || now, status === 'graduated' ? now : null, now,
      price, existing?.trades || 0, l.holders, existing?.volume || 0);
  return { mint: l.mint, price, status };
}

function pushCandle(mint, price, vol, at = Date.now()) {
  if (!(price > 0)) return;
  const ts = Math.floor(at / 60_000) * 60_000;
  const c = db.prepare('SELECT * FROM candles WHERE mint=? AND ts=?').get(mint, ts);
  if (!c) {
    const prev = db.prepare('SELECT c FROM candles WHERE mint=? AND ts<? ORDER BY ts DESC LIMIT 1').get(mint, ts);
    const o = prev ? prev.c : price;
    db.prepare('INSERT INTO candles(mint,ts,o,h,l,c,v,n) VALUES(?,?,?,?,?,?,?,1)').run(mint, ts, o, Math.max(o, price), Math.min(o, price), price, vol);
  } else {
    db.prepare('UPDATE candles SET h=?,l=?,c=?,v=v+?,n=n+1 WHERE mint=? AND ts=?').run(Math.max(c.h, price), Math.min(c.l, price), price, vol, mint, ts);
  }
}

/** Mirror on-chain Position accounts into `holdings`, so every existing holder/portfolio/
 *  leaderboard read works unchanged — including the conviction tier, which comes from the
 *  on-chain clock rather than anything we track ourselves. */
function syncHoldings(positions, mintByLaunchPk) {
  const seen = new Set();
  const up = db.prepare(`INSERT INTO holdings(wallet,mint,amount,held_since,cost,realized,yield_earned) VALUES(?,?,?,?,0,0,0)
    ON CONFLICT(wallet,mint) DO UPDATE SET amount=excluded.amount, held_since=excluded.held_since`);
  for (const p of positions) {
    const mint = mintByLaunchPk.get(p.launch); if (!mint) continue;
    up.run(p.owner, mint, ut(p.amount), p.heldSince || null);
    seen.add(p.owner + '|' + mint);
  }
  // Drop positions that closed on chain — but ONLY for the launches this indexer actually owns.
  //
  // ⛔ THIS USED TO WALK EVERY ROW IN `holdings`, FOR EVERY MINT. Positions exist only for coins on
  // our own curve program, so every row belonging to a Meteora launch failed the `seen` check and
  // was deleted. `mirrorHolders` writes the real holders of a dbc coin into this same table so the
  // reward epoch can see them; this loop deleted all 16 of them seconds later, every pass. The
  // visible symptom was that no dbc coin had ever paid an epoch — $BITE sat on 56,566 REX of holder
  // money with 16 holders on chain and `yield_epochs` stuck at 0 — and it looked for all the world
  // like the mirror was never running, because by the time anything looked, its rows were gone.
  //
  // A reconciler may only delete what it is authoritative for. These launches, and nothing else.
  const ours = new Set(mintByLaunchPk.values());
  for (const row of db.prepare('SELECT wallet, mint FROM holdings').all()) {
    if (!ours.has(row.mint)) continue;
    if (!seen.has(row.wallet + '|' + row.mint)) db.prepare('DELETE FROM holdings WHERE wallet=? AND mint=?').run(row.wallet, row.mint);
  }
}

/** Reconcile every launch from chain state. Cheap enough to run on a short timer. */
export async function reconcile() {
  const rows = await CH.launches();
  const byLaunchPk = new Map(rows.map((l) => [CH.launchPda(l.mint).toBase58(), l.mint]));
  const out = [];
  for (const l of rows) {
    try { const r = tx(() => upsertLaunch(l)); pushCandle(r.mint, r.price, 0); out.push(r); }
    catch (e) { warn('index', l.mint.slice(0, 6), e.message); }
  }
  try { const positions = await CH.allPositions(); tx(() => syncHoldings(positions, byLaunchPk)); }
  catch (e) { warn('holdings sync', e.message); }
  // Same map, same rows — so publishing it here means nothing that resolves a launch can run against
  // a stale one. The backfill in particular refuses to advance past a launch it cannot resolve, and
  // an empty map would make it refuse to advance at all.
  mintByLaunch = byLaunchPk;
  return out;
}

// ---------------------------------------------------------------- live events
let sub = null;
export const events = []; // drained by the server and broadcast, same shape the UI already handles

/**
 * Record one trade. Called by BOTH feeds for the same trade, so it has to be idempotent and it has
 * to say which of three things happened:
 *   'new'      — written, and the volume/candle/tape were updated for it
 *   'dup'      — the other feed already has it; counting it again would double the volume
 *   'unknown'  — the launch is not indexed yet, so there is nothing to attach it to. The caller must
 *                NOT treat this as handled: the backfill stops its walk here rather than advancing
 *                its cursor past a trade it failed to record, and retries after the next reconcile.
 */
export function recordTrade(ev) {
  const mint = ev.launchMint;
  const t = db.prepare('SELECT symbol, name, image, quote, quote_mint, price FROM tokens WHERE mint=?').get(mint);
  if (!t) return 'unknown';
  // Without the quote asset's mint we do not know its decimals, and every amount on this trade would
  // be scaled by the wrong power of ten — a SOL-quoted trade recorded as if it were six-decimal is
  // out by a thousand. Refusing is what holds the backfill cursor, so the trade is retried rather
  // than written wrong and promised to an aggregator.
  const qm = ev.quoteMint || t.quote_mint;
  if (!qm) { warn('index', mint.slice(0, 6), 'trade on a launch whose quote mint is unknown — not recording'); return 'unknown'; }
  const quote = uq(ev.quote, qm), tokens = ut(ev.tokens);
  const price = tokens > 0 ? quote / tokens : t.price;
  // A trade we are learning about late is timestamped by its BLOCK, not by the clock: filing an
  // hour-old trade into the current minute's candle would invent a price move that never happened.
  const ts = ev.ts || Date.now();
  // `kind` separates a curve swap from a Fair Open fill. Both are real buys and both belong in the
  // volume and the chart; only the fill is counted by the Fair Open fills figure.
  const kind = ev.kind || 'chain';
  const row = { mint, wallet: ev.user, side: ev.isBuy ? 'buy' : 'sell', quote, tokens, price, fee: 0, tax: 0, kind, ts, slot: ev.slot ?? null, sig: ev.sig ?? null, ev_ix: ev.evIx ?? null };
  const r = db.prepare(`INSERT INTO trades(mint,wallet,side,quote,tokens,price,fee,tax,kind,ts,slot,sig,ev_ix)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
    .run(row.mint, row.wallet, row.side, row.quote, row.tokens, row.price, 0, 0, kind, row.ts, row.slot, row.sig, row.ev_ix);
  if (r.changes === 0) return 'dup';
  db.prepare('UPDATE tokens SET trades=trades+1, volume=volume+?, last_trade_at=MAX(COALESCE(last_trade_at,0),?) WHERE mint=?').run(quote, row.ts, mint);
  pushCandle(mint, price, quote, row.ts);
  // The tape is the live stream's job. A backfilled trade is only pushed when it is recent enough to
  // still be the news it would have been — otherwise a cold start would replay the whole history
  // into everyone's trade feed as if it had just happened.
  if (ev.live || ts > Date.now() - 300_000) {
    events.push({ type: 'trade', ...row, symbol: t.symbol, name: t.name, image: t.image, quoteSymbol: t.quote, candle: { ts: row.ts, o: price, h: price, l: price, c: price, v: quote } });
  }
  return 'new';
}

/**
 * Write one trade per Fair Open fill.
 *
 * A Fair Open is a real buy — one aggregate buy on the curve that clears everybody at a single
 * price — but nothing on chain says who got what. `settle_fair_open` emits only the aggregate, and
 * `claim_fair_open` emits nothing at all, so a fill left no trace anywhere: not in the tape, not in
 * the volume, not in the Fair Open fills counter, and (since the adapter shipped) not in the chart
 * any aggregator draws of us. The pad's headline mechanic was the one thing it could not show.
 *
 * No contract change is needed to fix it, because the allocation is not a secret — it is a
 * division. Each commitment's share of `fair_open_total` buys the same share of `fair_open_tokens`,
 * which is precisely the arithmetic `claim_fair_open` performs. So the fills are recomputed here
 * from the commitments, at the one uniform price, and written like any other trade.
 *
 * Idempotent through the usual key: the settle signature with one event index per bidder. Bidders
 * are sorted so that index is stable across runs — without that, a re-run could number the same
 * bidder differently and insert their fill twice.
 */
async function recordFairOpenFills(mint, sig, slot, ts) {
  try {
    const l = (await CH.launches()).find((x) => x.mint === mint);
    if (!l || !(l.fairOpenTokens > 0) || !(l.fairOpenTotal > 0)) return 0;
    const commits = (await CH.commitsOf(mint)).sort((a, b) => (a.bidder < b.bidder ? -1 : a.bidder > b.bidder ? 1 : 0));
    if (!commits.length) return 0;
    const qm = String(l.quoteMint);
    // What the bidders actually paid: the committed total less whatever the curve could not take.
    const spent = Math.max(0, l.fairOpenTotal - (l.fairOpenClaimedQuote || 0));
    let n = 0;
    commits.forEach((c, i) => {
      const tokens = Math.floor(l.fairOpenTokens * c.amount / l.fairOpenTotal);
      const quote = Math.floor(spent * c.amount / l.fairOpenTotal);
      if (!(tokens > 0) || !(quote > 0)) return;
      const got = recordTrade({ launchMint: mint, user: c.bidder, isBuy: true, quote, tokens, quoteMint: qm,
        slot, sig, evIx: FILL_IX_BASE + i, ts, kind: 'fairopen', live: false });
      if (got === 'new') n++;
    });
    if (n) log('⚖️  fair open', mint.slice(0, 6), 'recorded', n, 'fill(s) at one clearing price');
    return n;
  } catch (e) { warn('fair open fills', mint.slice(0, 6), e.message); return 0; }
}
// Fill event indices live above any plausible count of Traded events in one transaction, so a fill
// and a swap in the same signature can never collide on the dedupe key.
const FILL_IX_BASE = 1000;

/**
 * Which way a trade went.
 *
 * The IDL names this field `is_buy` and Anchor's coder hands it back exactly as named, so reading
 * `d.isBuy` got undefined — and because undefined is falsy, EVERY on-chain trade was recorded as a
 * sell: wrong in the tape, wrong in the buy/sell volume, and wrong in the first chart any aggregator
 * would ever have drawn of us. Both spellings are accepted, because which one arrives depends on the
 * IDL format the program was built with.
 *
 * Neither present is a decode failure, not a sell. Guessing here silently inverts every chart we
 * serve, which is precisely how the original bug stayed invisible, so it is reported instead.
 */
export function isBuyOf(d) {
  const v = d?.is_buy ?? d?.isBuy;
  return typeof v === 'boolean' ? v : null;
}

/**
 * Decode one transaction's logs and record every trade in it. Shared by the live subscription and
 * the backfill so that both number the events in a transaction IDENTICALLY — that shared numbering
 * is the dedupe key, so if the two paths ever disagreed about it the backfill would duplicate
 * everything it re-walked.
 */
function ingestLogs({ logs, sig, slot, ts, live = false }) {
  let evIx = 0, inserted = 0, deferred = 0;
  // Settlements are returned rather than handled here: rebuilding the fills needs the chain, and
  // this function has to stay synchronous because the live subscription calls it from a callback.
  const settled = [];
  for (const ev of parser().parseLogs(logs)) {
    const d = ev.data;
    if (/^traded$/i.test(ev.name)) {
      const mint = launchToMint(d.launch.toBase58());
      const buy = isBuyOf(d);
      if (mint && buy === null) warn('event decode', 'Traded carries neither is_buy nor isBuy — refusing to guess the side');
      const got = mint && buy !== null
        ? recordTrade({ launchMint: mint, user: d.user.toBase58(), isBuy: buy, quote: d.quote, tokens: d.tokens, quoteMint: quoteMintOf(mint), slot, sig, ts, evIx, live })
        : 'unknown';
      if (got === 'new') inserted++;
      if (got === 'unknown') deferred++;
      // Incremented even when the trade could not be recorded, so the numbering is a property of the
      // transaction and not of how much we happened to know when we read it.
      evIx++;
    }
    // Collected on BOTH feeds, above the live-only line. A settlement seen only by the live
    // subscription is lost whenever that subscription drops — which is the whole reason the
    // backfill exists, and the fills are real trades that have to survive the same way swaps do.
    if (/fairopensettled/i.test(ev.name)) {
      const mint = launchToMint(d.launch.toBase58());
      if (mint) settled.push(mint); else deferred++;
    }
    if (!live) continue;   // the rest drive live UI only; the backfill reconciles state anyway
    if (/committed/i.test(ev.name)) {
      const mint = launchToMint(d.launch.toBase58());
      if (mint) { const qm2 = quoteMintOf(mint); events.push({ type: 'fairopen', mint, total: uq(d.total, qm2), bidders: 0, wallet: d.bidder.toBase58(), amount: uq(d.amount, qm2) }); }
    }
    if (/fairopensettled/i.test(ev.name)) {
      const mint = launchToMint(d.launch.toBase58());
      if (mint) events.push({ type: 'settled', mint, total: uq(d.total, quoteMintOf(mint)), bidders: 0, price: 0, symbol: '', name: '', image: null, ts: Date.now() });
    }
    if (/launchcreated/i.test(ev.name)) reconcile().catch(() => {});
  }
  return { inserted, deferred, settled };
}

let _parser = null;
const parser = () => (_parser ||= new anchor.EventParser(CH.programId(), new anchor.BorshCoder(CH.idl())));

/**
 * Decode program logs into UI events in real time. This feed is FAST but NOT RELIABLE: a websocket
 * drops, the RPC rate-limits it, a reconnect misses whatever happened in between — and nothing in
 * the stream tells us so. It drives the live tape; `backfill()` is what makes the record complete.
 */
export async function watch() {
  if (sub) return;
  sub = CH.conn().onLogs(CH.programId(), (l, ctx) => {
    if (l.err) return;
    try {
      const r = ingestLogs({ logs: l.logs, sig: l.signature, slot: ctx?.slot ?? null, ts: Date.now(), live: true });
      // Reconcile first: the fills are computed from the settled launch's own totals, which are only
      // correct once the launch account has been re-read.
      for (const mint of r.settled) reconcile().then(() => recordFairOpenFills(mint, l.signature, ctx?.slot ?? null, Date.now())).catch(() => {});
    } catch (e) { warn('event decode', e.message); }
  }, 'confirmed');
  log('👁  watching program logs for live events');
}

// ---------------------------------------------------------------- backfill
// Why this exists: the log subscription is the ONLY way a trade used to reach the database, and a
// dropped subscription loses it silently. That was survivable while the trade tape was ours alone —
// a missing row is a missing row. It stops being survivable the moment an aggregator reads us,
// because `/dex/latest-block` is a PROMISE that we have reported everything up to that block. Claim
// a slot above a hole and DexScreener moves its cursor past the hole and never asks again: the gap
// is permanent and invisible, in their chart and in ours.
//
// So the authority on completeness is not the stream. It is this: walk the program's own signature
// list, in order, and keep a cursor that only ever moves across an unbroken run of transactions we
// actually recorded. `latest-block` reports THAT cursor. The stream is then free to be lossy.
const SIG_PAGE = 1000;                                        // the RPC's own per-call maximum
const MAX_PAGES = Number(process.env.BACKFILL_PAGES || 25);   // 25k signatures in one round
// A public RPC rate-limits getTransaction well before it rate-limits anything else, so the walk is
// paced and bounded rather than run flat out. Neither number affects correctness: the cursor only
// ever moves forward, so a round that ends early simply leaves the rest for the next one.
const MAX_TX = Number(process.env.BACKFILL_MAX_TX || 200);    // transactions read per round
const PACE_MS = Number(process.env.BACKFILL_PACE_MS || 40);   // between reads
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (e) => /429|too many requests|rate/i.test(String(e?.message || e));

/** Retry a read that the RPC refused for rate reasons. Anything else throws straight through — a
 *  real decode or network error should stop the walk, not be papered over. */
async function rpcRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries || !is429(e)) throw e; await sleep(400 * 2 ** i + Math.random() * 200); }
  }
}

/** Program signatures newer than `untilSig`, oldest first. */
async function sigsSince(untilSig) {
  const conn = CH.conn(), pid = CH.programId();
  const pages = [];
  let before, truncated = false;
  for (let i = 0; ; i++) {
    if (i >= MAX_PAGES) { truncated = true; break; }
    const opts = { limit: SIG_PAGE };
    if (before) opts.before = before;
    if (untilSig) opts.until = untilSig;
    const batch = await conn.getSignaturesForAddress(pid, opts, 'confirmed');
    if (!batch.length) break;
    pages.push(batch);
    if (batch.length < SIG_PAGE) break;       // reached the cursor
    before = batch[batch.length - 1].signature;
  }
  return { sigs: pages.flat().reverse(), truncated };   // pages descend; flatten then flip to ascend
}

/** Fetch one transaction and record every trade in it. */
async function ingestSig(s) {
  const tx0 = await rpcRetry(() => CH.conn().getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
  const logs = tx0?.meta?.logMessages;
  if (!logs) return { inserted: 0, deferred: 0 };
  const bt = tx0.blockTime ?? s.blockTime;
  const ts = bt ? bt * 1000 : Date.now();
  const r = ingestLogs({ logs, sig: s.signature, slot: tx0.slot ?? s.slot, ts, live: false });
  // Awaited, unlike the live path, because the cursor must not cross a settlement whose fills we
  // failed to write — the same rule every other record on this walk follows.
  for (const mint of r.settled) {
    await reconcile();
    r.inserted += await recordFairOpenFills(mint, s.signature, tx0.slot ?? s.slot, ts);
  }
  return r;
}

let backfilling = false;
/**
 * Advance the completeness cursor as far as an unbroken run of recorded transactions allows.
 * Returns what it did, or null when there is nothing to do.
 */
export async function backfill() {
  if (cfg.sim || !cfg.rpcUrl || backfilling) return null;
  backfilling = true;
  try {
    if (!mintByLaunch.size) await refreshLaunchMap();
    const cursor = kv.get('backfill_sig');
    const { sigs, truncated } = await sigsSince(cursor);
    let done = null, found = 0, stopped = null, read = 0;
    for (const s of sigs) {
      // Bounded work per round. Stopping here is not a failure — the cursor keeps what it earned and
      // the next round starts from it, so a long history drains over several rounds.
      if (read >= MAX_TX) { stopped = `round budget (${MAX_TX} tx) — more to walk`; break; }
      // A failed transaction changed no state, so there is nothing to record and nothing to wait
      // for — the cursor may cross it.
      if (s.err) { done = s; continue; }
      let r;
      if (read++) await sleep(PACE_MS);
      try { r = await ingestSig(s); }
      catch (e) { stopped = `${s.signature.slice(0, 8)}: ${e.message}`; break; }
      found += r.inserted;
      // A trade on a launch we have not indexed yet. The cursor must not cross it, or the promise
      // would cover a trade we never recorded. Stop; the next reconcile indexes the launch and the
      // next round picks up from exactly here.
      if (r.deferred) { stopped = `${s.signature.slice(0, 8)}: launch not indexed yet`; break; }
      done = s;
    }
    // The cursor is the promise `latest-block` is built on. It moves only when the walk reached it
    // from the previous cursor without a break — EXCEPT on a cold start, where there is no previous
    // cursor and the record simply begins at the oldest signature we could reach.
    const advance = done && (!truncated || !cursor);
    if (truncated) warn('backfill', 'more than', MAX_PAGES * SIG_PAGE, 'signatures to walk —',
      cursor ? 'completeness HELD at slot ' + (kv.get('backfill_slot') || 0) : 'record starts at slot ' + sigs[0]?.slot);
    if (advance) {
      kv.set('backfill_sig', done.signature);
      kv.set('backfill_slot', done.slot);
      if (done.blockTime) kv.set('backfill_ts', done.blockTime);
    }
    if (found) log('↩️  backfill recovered', found, 'trade(s) the log stream never delivered');
    if (stopped) warn('backfill', 'stopped at', stopped, '— cursor stays at slot', kv.get('backfill_slot') || 0);
    return { scanned: sigs.length, read, recovered: found, slot: advance ? done.slot : Number(kv.get('backfill_slot') || 0), truncated, stopped };
  } catch (e) { warn('backfill', e.message); return null; }
  finally { backfilling = false; }
}
/** The slot through which every program transaction has been read and recorded. 0 = nothing claimed. */
export const completeSlot = () => Number(kv.get('backfill_slot') || 0);
export const completeTs = () => Number(kv.get('backfill_ts') || 0);
let mintByLaunch = new Map();
const launchToMint = (launchPk) => mintByLaunch.get(launchPk) || null;
async function refreshLaunchMap() {
  const rows = await CH.launches(); // served from the shared cache
  mintByLaunch = new Map(rows.map((l) => [CH.launchPda(l.mint).toBase58(), l.mint]));
}

// ---------------------------------------------------------------- reward crank
/**
 * Snapshot holders, post the root, and persist the leaves so we can serve proofs.
 *
 * How the pot is split between them is the launch's own `reward_mode`: 'hold' (Diamond Hands —
 * balance x a 1.0x..3.0x conviction multiplier by hours held, the default) or 'flat' (balance
 * alone). The floor is the quote-asset equivalent of $20 and is applied to BALANCE in both modes,
 * and the launch's own vaults — plus any wallet flagged as a reserve or team lock locally — never
 * earn.
 */
export async function runEpoch(mint) {
  const l = (await CH.launches()).find((x) => x.mint === mint);
  if (!l || l.rewardPot <= 0) return null;
  const positions = await CH.positionsOf(mint);
  if (!positions.length) return null;
  const quoteUsd = usdOf(quoteSymbol(l.quoteMint));
  const price = l.status === 'graduated'
    ? (l.ammToken > 0 ? l.ammQuote / l.ammToken : 0)
    : (l.vToken > 0 ? l.vQuote / l.vToken : 0);
  const exclude = new Set([
    CH.launchPda(mint).toBase58(), CH.tokenVaultPda(CH.launchPda(mint)).toBase58(),
    CH.quoteVaultPda(CH.launchPda(mint)).toBase58(), CH.rewardVaultPda(CH.launchPda(mint)).toBase58(),
    ...db.prepare('SELECT wallet FROM wallets WHERE bot=2').all().map((r) => r.wallet),
  ]);
  // The ops slice comes off the top, before the pot is split, and then rides in the SAME merkle tree
  // as a leaf — so operations claim it exactly the way a holder claims theirs, and it shows up in the
  // epoch like any other line rather than disappearing into a transfer nobody can see.
  const opsBps = Math.max(0, Math.min(1000, cfg.opsBps || 0));
  const opsCut = cfg.opsWallet && opsBps > 0 ? Math.floor(Number(l.rewardPot) * opsBps / 10_000) : 0;
  const holderPot = Number(l.rewardPot) - opsCut;
  // Diamond Hands needs a hold clock, and the chain does not carry one: `positionsOf` reads token
  // accounts, which know a balance and nothing about how long it has been there. The clock lives in
  // the local `holdings` table, written by the indexer and cleared on a sell, so it is attached here
  // by owner. A holder we have no local row for keeps a null clock and lands on the bottom rung at
  // 1.0x — paid their balance share, never dropped.
  const row = db.prepare('SELECT reward_mode, payout_rule, payout_n FROM tokens WHERE mint=?').get(mint) || {};
  const mode = row.reward_mode || 'hold';
  // Who is eligible, which the launcher chose at launch — Whale Club, Shrimp Fund, a flat dividend,
  // or everyone. Narrows the set the floor already filtered; it can never widen it.
  const payout = row.payout_rule || 'all';
  const payoutN = row.payout_n || 25;
  const heldBy = new Map(db.prepare('SELECT wallet, held_since FROM holdings WHERE mint=? AND amount > 0').all(mint)
    .map((r) => [r.wallet, r.held_since]));
  const withHold = positions.map((p) => ({ ...p, heldSince: heldBy.get(p.owner) ?? null }));
  const { weighted, total, skipped } = CH.proRata(withHold, { priceUsd: price * quoteUsd, floorUsd: cfg.rewardFloorUsd, exclude, mode, payout, payoutN });
  const alloc = CH.allocate(weighted, total, holderPot);
  if (opsCut > 0) alloc.push({ owner: cfg.opsWallet, amount: opsCut, ops: true });
  if (skipped.length) log('💎 epoch', mint.slice(0, 6), 'skipped', skipped.length, 'positions under the $' + cfg.rewardFloorUsd + ' floor or excluded');
  if (!alloc.length) return null;
  const epochIndex = l.epochCount;
  const ep = CH.epochPda(CH.launchPda(mint), epochIndex).toBase58();
  const leaves = alloc.map((x) => CH.leafOf(x.owner, x.amount, ep));
  const { root, layers } = CH.buildTree(leaves);
  const sig = await CH.postEpoch(mint, root, l.rewardPot);
  const rootHex = Buffer.from(root).toString('hex');
  const ins = db.prepare('INSERT OR REPLACE INTO epoch_alloc(mint,epoch_index,wallet,amount,mult,proof,root,ts) VALUES(?,?,?,?,?,?,?,?)');
  tx(() => alloc.forEach((x, i) => ins.run(mint, epochIndex, x.owner, x.amount, 1, JSON.stringify(CH.proofFor(layers, i)), rootHex, Date.now())));
  const qm = String(l.quoteMint);
  db.prepare('UPDATE tokens SET yield_paid=yield_paid+?, yield_payouts=yield_payouts+?, yield_pool=0 WHERE mint=?').run(uq(l.rewardPot, qm), alloc.length, mint);
  log('💎 epoch', epochIndex, 'posted for', mint.slice(0, 6), 'pot', uq(l.rewardPot, qm),
    opsCut > 0 ? `(ops ${(opsBps / 100).toFixed(2)}% = ${uq(opsCut, qm)})` : '', 'to', alloc.length - (opsCut > 0 ? 1 : 0), 'holders', sig.slice(0, 8));
  events.push({ type: 'yield', mint, symbol: db.prepare('SELECT symbol FROM tokens WHERE mint=?').get(mint)?.symbol || '', image: null, quote: quoteSymbol(qm), pool: uq(l.rewardPot, qm), holders: alloc.length, top: alloc.slice(0, 5).map((x) => ({ wallet: x.owner, amount: uq(x.amount, qm) })), ts: Date.now() });
  return { epochIndex, alloc: alloc.length, sig };
}
export async function runEpochsDue() {
  const out = [];
  for (const l of await CH.launches()) {
    // The first epoch on a pair publishes whatever it collected — the spec calls a zero first page a
    // bug, so the dust threshold only starts applying from the second epoch onward.
    if (l.epochCount > 0 && uq(l.rewardPot, String(l.quoteMint)) * usdOf(quoteSymbol(l.quoteMint)) < cfg.minEpochUsd) continue;
    try { const r = await runEpoch(l.mint); if (r) out.push(r); } catch (e) { warn('epoch', l.mint.slice(0, 6), e.message); }
  }
  return out;
}
/** Everything a wallet can still claim, with its merkle proof. */
export function claimable(wallet) {
  const rows = db.prepare(`SELECT a.*, t.symbol, t.quote FROM epoch_alloc a LEFT JOIN tokens t ON t.mint=a.mint WHERE a.wallet=? ORDER BY a.ts DESC LIMIT 100`).all(wallet);
  return rows.map((r) => ({ mint: r.mint, index: r.epoch_index, amount: r.amount, amountUi: uq(r.amount, mintOfQuoteSymbol(r.quote)), mult: r.mult, proof: JSON.parse(r.proof), symbol: r.symbol, quote: r.quote, ts: r.ts }));
}

// ---------------------------------------------------------------- lifecycle
export async function start() {
  await refreshLaunchMap();
  await reconcile();
  await watch();
  // The backfill runs AFTER reconcile, in the same tick, deliberately: it refuses to advance past a
  // trade on a launch it cannot resolve, and reconcile is what makes a launch resolvable.
  await backfill();
  setInterval(async () => {
    try { await refreshLaunchMap(); await reconcile(); } catch (e) { warn('reconcile', e.message); }
    try { await backfill(); } catch (e) { warn('backfill', e.message); }
  }, Number(process.env.RECONCILE_MS || 20_000));
  setInterval(async () => { try { await runEpochsDue(); } catch (e) { warn('epochs', e.message); } }, Math.max(30_000, cfg.epochMs));
  log('📇 indexer running — complete through slot', completeSlot() || '(nothing yet)');
}
