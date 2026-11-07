// Activity simulator (SIM=1 only): populates the market with REAL coins pulled from StonkFun's public API
// (names, tickers, PFPs, links, creators, market state) and keeps it moving with bot wallets (flagged bot=1).
// Off by default in production.
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { db, tx } from './db.mjs';
import { cfg, log, warn } from './config.mjs';
import * as E from './engine.mjs';
import { usdOf } from './prices.mjs';
import { loadRoster, loadNewest } from './stonkfun.mjs';

const inQuote = (usd, quote) => usd / (usdOf(quote) || 1);
const HANDLES = ['degen_0x7', 'moon_maxi', 'forgehand', 'quietwhale', 'ape_sensei', 'sol_stacker', 'gpgoblin', 'emberlord', 'anvilhead', 'slowmoney', 'tinker', 'bagholder_prime', 'candlewatcher', 'nightshift', 'ironwill', 'coalminer', 'ratio_king', 'sparkplug', 'diamondjoe', 'flipper', 'oldhand', 'newblood', 'bellwether', 'hodlgnome'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const logu = (a, b) => Math.exp(rnd(Math.log(a), Math.log(b)));
let bots = [];
const WHALE = bs58.encode(crypto.createHash('sha256').update('forge-seed-whale').digest()); // holds the "already bought" part of each real coin's curve; never trades

function ensureBots() {
  bots = HANDLES.map((h, i) => bs58.encode(crypto.createHash('sha256').update('forge-bot-' + h + i).digest()));
  for (let i = 0; i < bots.length; i++) {
    E.ensureWallet(bots[i], 1);
    db.prepare('UPDATE wallets SET name=? WHERE wallet=? AND name IS NULL').run(HANDLES[i], bots[i]);
    if (E.balanceOf(bots[i], 'SOL') < 40) { E.credit(bots[i], 'SOL', 400); E.credit(bots[i], 'USDC', 60_000); E.credit(bots[i], 'GP', 40_000_000); E.credit(bots[i], 'REX', 400_000_000); }
  }
  E.ensureWallet(WHALE, 2); db.prepare("UPDATE wallets SET name='curve_reserve', bot=2 WHERE wallet=?").run(WHALE);
  E.credit(WHALE, 'SOL', 1e6); E.credit(WHALE, 'USDC', 1e8); E.credit(WHALE, 'GP', 1e11); E.credit(WHALE, 'REX', 1e13);
}
function botTrade(t, buyBias = 0.55) {
  const w = pick(bots); const price = t.quoteUsd || 1;
  const holding = E.holdingOf(w, t.mint).amount;
  const wantBuy = Math.random() < buyBias || holding < 1;
  // size to the pool: ≤0.4% of an AMM's quote side, ≤5% of a curve's reserves (with a small floor)
  const cap = t.status === 'graduated' ? (t.liquidity / 2) * 0.004 : Math.max(5 / price, (t.raised || 0) * 0.05);
  try {
    if (wantBuy) { const usdAmt = logu(3, t.status === 'graduated' ? 900 : 400); const amt = Math.min(E.balanceOf(w, t.quote) * 0.5, usdAmt / price, cap); if (amt * price > 0.5) E.buy(w, t.mint, amt); }
    else { const frac = Math.random() < 0.35 ? 1 : rnd(0.1, 0.6); const tokens = Math.min(holding * frac, cap / (t.price || 1)); if (tokens > 1) E.sell(w, t.mint, tokens); }
  } catch { /* insufficient funds etc. — fine for a bot */ }
}
function withClock(fakeNow, fn) { const real = Date.now; Date.now = () => fakeNow.t; try { return fn(); } finally { Date.now = real; } }
// A real StonkFun creator address is used as-is so the demo credits the right dev, but that wallet
// has never seen this ledger — fund it, or a dev buy priced in a cheap quote outruns the faucet and
// takes the whole seed down with it.
function creatorOf(t) {
  const w = (typeof t.creator === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.creator)) ? t.creator : pick(bots);
  E.ensureWallet(w, 1);
  if (E.balanceOf(w, 'SOL') < 40) { E.credit(w, 'SOL', 400); E.credit(w, 'USDC', 60_000); E.credit(w, 'GP', 40_000_000); E.credit(w, 'REX', 400_000_000); }
  return w;
}
const launchArgs = (t, fo) => ({ name: t.name, symbol: t.symbol, quote: t.quote, ...(t.fees || { holderBps: 100, creatorBps: 100, vaultBps: 100, burnBps: 100 }), fairOpenSecs: fo, description: t.description || '', image: t.image, website: t.website, twitter: t.twitter, telegram: t.telegram, devBuy: inQuote(logu(150, 1200), t.quote) });

// Put a freshly opened coin where it really is on StonkFun: graduated coins land on the AMM at their real market cap,
// bonding coins are bought up to their real curve progress. The reserve whale holds that supply and never trades.
function reflectReal(mint, real) {
  const t = E.getToken.get(mint); if (!t || t.status !== 'live') return;
  const usd = usdOf(t.quote) || 1;
  if (real.status === 'graduated') {
    try { E.buy(WHALE, mint, t.raise_target * 2); } catch (e) { warn('reflect graduate', t.symbol, e.message); return; }
    const price = Math.min(real.mcapUsd, 5_000_000) / E.TOTAL_SUPPLY / usd;
    // the coin has been trading for days: start its chart at the real price, not at our curve's opening
    db.prepare('DELETE FROM candles WHERE mint=?').run(mint);
    if (price > 0) E.setAmmPrice(mint, price);
  } else {
    const targetNet = t.raise_target * Math.min(0.97, Math.max(0, real.progress)) - t.real_quote;
    if (targetNet > 0) { try { E.buy(WHALE, mint, targetNet / (1 - 0.01 - t.tax_bps / 1e4)); } catch (e) { warn('reflect progress', t.symbol, e.message); } }
  }
  db.prepare('UPDATE tokens SET created_at=?, opened_at=? WHERE mint=?').run(real.createdAt, real.createdAt + 60_000, mint);
  E.events.length = 0;
}

const REX_SHARE = 0.55; // share of the demo roster re-quoted in $REX
// A REX-quoted pair is the one the spec aims at the Stonk cohort first: 2% holders, 1% creator.
function rexify(list) { return list.map((t, i) => (i % 100) / 100 < REX_SHARE ? { ...t, quote: 'REX', fees: { holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0 } } : t); }
export async function seedIfEmpty() {
  ensureBots();
  if (db.prepare('SELECT COUNT(*) n FROM tokens').get().n > 0) return;
  log('🌱 seeding demo market from StonkFun (SIM=1)…');
  const roster = rexify(await loadRoster());
  if (!roster.length) { warn('no roster from StonkFun — market left empty'); return; }
  const realNow = Date.now();
  const clock = { t: realNow - 7 * 3_600_000 };
  withClock(clock, () => {
    for (const rt of roster) {
      const t = E.createToken(creatorOf(rt), launchArgs(rt, 60));
      for (let i = 0; i < 3 + Math.floor(rnd(0, 6)); i++) { const w = pick(bots); try { E.placeBid(w, t.mint, inQuote(logu(40, 900), t.quote)); } catch {} }
      clock.t += 61_000; E.settleDue();
      reflectReal(t.mint, rt.real);
      clock.t += rnd(1, 4) * 60_000;
    }
    // 7 hours of activity so charts, holders and the first epochs have history
    const walk = (end) => { let i = 0; while (clock.t < end) {
      const live = db.prepare("SELECT * FROM tokens WHERE status IN ('live','graduated')").all();
      const t = pick(live); if (t) botTrade(E.publicToken(t, { stats: false }), t.status === 'live' ? 0.6 : 0.52);
      clock.t += logu(4, 45) * 1000;
      if (++i % 400 === 0) { db.prepare("INSERT INTO meta(k,v) VALUES('epoch_at',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(clock.t - cfg.epochMs - 1)); E.runEpoch(); }
    } };
    walk(realNow - 40 * 60_000);
    // land graduated coins on their live StonkFun market cap, then let the last 40 minutes trade naturally
    for (const rt of roster) if (rt.real.status === 'graduated') { const row = db.prepare('SELECT mint FROM tokens WHERE symbol=? AND name=?').get(rt.symbol, rt.name); if (row) E.setAmmPrice(row.mint, Math.min(rt.real.mcapUsd, 5_000_000) / E.TOTAL_SUPPLY / (usdOf(rt.quote) || 1)); }
    walk(realNow - 60_000);
  });
  db.prepare("INSERT INTO meta(k,v) VALUES('epoch_at',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(Date.now() - cfg.epochMs * 0.4));
  // two of the newest real launches are in their Fair Open window right now
  const fresh = rexify(await refillPool(2));
  for (const [rt, fo] of fresh.slice(0, 2).map((x, i) => [x, i ? 300 : 120])) {
    const t = E.createToken(creatorOf(rt), launchArgs(rt, fo)); pool = pool.filter((x) => x !== rt);
    for (let i = 0; i < 2 + Math.floor(rnd(0, 4)); i++) { const w = pick(bots); try { E.placeBid(w, t.mint, inQuote(logu(30, 600), t.quote)); } catch {} }
  }
  E.events.length = 0; // don't replay the seed as live events
  log('🌱 seeded', db.prepare('SELECT COUNT(*) n FROM tokens').get().n, 'real coins,', db.prepare('SELECT COUNT(*) n FROM trades').get().n, 'trades');
}

// Live launch pool: real newest StonkFun launches not yet on FORGE.
let pool = [], poolAt = 0;
const known = () => new Set(db.prepare('SELECT symbol FROM tokens').all().map((r) => r.symbol));
async function refillPool(min = 4) {
  if (pool.length >= min && Date.now() - poolAt < 10 * 60_000) return pool;
  try { pool = await loadNewest(known(), 12); poolAt = Date.now(); log('📡 launch pool:', pool.map((t) => t.symbol).join(' ') || '(empty)'); } catch (e) { warn('pool refill failed', e.message); }
  return pool;
}
export function startSim() {
  const tick = () => {
    try {
      const live = db.prepare("SELECT * FROM tokens WHERE status IN ('live','graduated') ORDER BY created_at DESC LIMIT 40").all();
      if (live.length) { const t = Math.random() < 0.5 ? live[Math.floor(Math.random() * Math.min(6, live.length))] : pick(live); botTrade(E.publicToken(t, { stats: false }), t.status === 'live' ? 0.62 : 0.53); }
      for (const t of db.prepare("SELECT * FROM tokens WHERE status='fairopen'").all()) if (Math.random() < 0.35) { const w = pick(bots); try { E.placeBid(w, t.mint, inQuote(logu(30, 700), t.quote)); } catch {} }
    } catch (e) { log('sim tick error', e.message); }
    setTimeout(tick, rnd(500, 1800));
  };
  setTimeout(tick, 1500);
  setInterval(() => { try { for (const b of bots) { if (E.balanceOf(b, 'SOL') < 40) E.credit(b, 'SOL', 400); if (E.balanceOf(b, 'USDC') < 6000) E.credit(b, 'USDC', 60_000); if (E.balanceOf(b, 'GP') < 4_000_000) E.credit(b, 'GP', 40_000_000); if (E.balanceOf(b, 'REX') < 40_000_000) E.credit(b, 'REX', 400_000_000); } } catch (e) { warn('bot top-up', e.message); } }, 10 * 60_000);
  const launch = async () => {
    try {
      await refillPool();
      const rt = pool.shift(); if (rt && Math.random() < REX_SHARE) { rt.quote = 'REX'; rt.fees = { holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0 }; }
      if (rt && !known().has(rt.symbol)) E.createToken(creatorOf(rt), launchArgs(rt, pick([60, 60, 120])));
    } catch (e) { log('sim launch error', e.message); }
    setTimeout(launch, rnd(cfg.epochMs >= 600_000 ? 360 : 150, cfg.epochMs >= 600_000 ? 720 : 300) * 1000); // ~6–12 min in the public demo, 2.5–5 min locally
  };
  setTimeout(launch, 60_000);
  log('🤖 sim running with', bots.length, 'bot wallets');
}
