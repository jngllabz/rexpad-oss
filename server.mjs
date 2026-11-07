import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { cfg, log, warn } from './lib/config.mjs';
import { db } from './lib/db.mjs';
import { makeNonce, verifySignature, createSession, walletFromToken, dropSession, isWallet, signInMessage } from './lib/auth.mjs';
import { QUOTES, refreshPrices, quoteList, usdOf, quoteBlock, venueBlock, setBadgeBlocks, CLUSTER, unpricedQuotes, priceSource, auditQuoteDecimals } from './lib/prices.mjs';
import * as E from './lib/engine.mjs';
import * as RW from './lib/rewards.mjs';
const REWARDS = RW;
import * as CH from './lib/chain.mjs';
import * as IX from './lib/indexer.mjs';
import * as NFT from './lib/nfts.mjs';
import * as PTS from './lib/points.mjs';
import * as FEAT from './lib/featured.mjs';
import * as META from './lib/meta.mjs';
import * as VLT from './lib/vault.mjs';
import * as BBK from './lib/buyback.mjs';
import * as OG from './lib/ogcard.mjs';
import * as EMB from './lib/embed.mjs';
import * as JUP from './lib/jupiter.mjs';
import * as DS from './lib/dexscreener.mjs';
import * as RECON from './lib/reconcile.mjs';
import { protocolPending } from './lib/payout.mjs';
import * as SHARE from './lib/shareboost.mjs';
import * as CALL from './lib/callouts.mjs';
import * as AI from './lib/ai_alloc.mjs';

/** Escape for an HTML attribute — these strings come from a creator's own launch form. */
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtMoney = (n) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + (n || 0).toFixed(2);

const PUB = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const IMG = path.join(cfg.dataDir, 'img');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2' };
// ---------- security headers, one definition for every response path
//
// From the RTS OMEGA pen test REX's auditor ran on 3 Oct: the HTML path carried nosniff / SAMEORIGIN
// / Referrer-Policy but the JSON path carried none of them (F7), and nothing anywhere carried HSTS,
// CSP or Permissions-Policy (F3, F5). Rather than repeat a header literal at each writeHead, every
// path now goes through these.
const BASE_SECURITY = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
// Everything the app actually pulls at runtime and nothing else: the chart bundle from jsDelivr, the
// web3 bundle the wallet path imports from esm.sh, the two font CDNs. Inline STYLE stays allowed
// because the markup is full of style="…" attributes; inline SCRIPT is not, which is the point —
// with Bearer tokens in localStorage, an injection into a token name or a chat line must not be able
// to run (F5).
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net https://esm.sh",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
  // Fontshare serves the @font-face CSS from api.fontshare.com but the font files themselves from
  // cdn.fontshare.com, so both have to be listed or the headline typeface silently falls back.
  "font-src 'self' https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com data:",
  // a coin's artwork can be any https URL the creator gave us
  "img-src 'self' data: https:",
  "connect-src 'self' https://esm.sh wss: https:",
  // The ONLY third party allowed to frame anything into this page: Birdeye's chart widget, used by
  // the featured sheet for mainnet coins we hold no candles for. Named explicitly rather than left
  // to fall back to default-src, and deliberately not a wildcard — an iframe runs in its own origin
  // but it can still navigate the top frame and cover the page, so the list stays one entry long.
  // ⛔ AND PRIVY'S WALLET FRAME, WITHOUT WHICH THE EMBEDDED WALLET CANNOT EXIST. Its key material
  // lives in a document on Privy's own origin — that separation IS the security argument for it, so
  // the frame is not decoration and blocking it does not degrade the feature, it removes it. Named
  // exactly, like Birdeye above, rather than widening this to a wildcard.
  "frame-src https://birdeye.so https://embed.birdeye.so https://auth.privy.io",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
const secure = (extra = {}, { csp = false, frame = 'SAMEORIGIN' } = {}) =>
  ({ ...BASE_SECURITY, ...(frame ? { 'x-frame-options': frame } : {}), ...(csp ? { 'content-security-policy': CSP } : {}), ...extra });

const json = (res, code, body) => { res.writeHead(code, secure({ 'content-type': 'application/json', 'cache-control': 'no-store' }, { frame: 'DENY' })); res.end(JSON.stringify(body)); };

/**
 * The origin to put in a canonical link or a social-card URL.
 *
 * It used to be whatever the request's Host header said, so `Host: evil.com` came back inside
 * <link rel="canonical"> and og:image (F1) — one cached response away from every shared link
 * unfurling with someone else's picture. The header is now only believed when it names a host we
 * actually answer on; anything else gets the canonical origin.
 */
const ALLOWED_HOSTS = new Set([
  ...String(process.env.PUBLIC_HOSTS || 'rexpad.fly.dev,rex.fun,www.rex.fun,play.rex.fun')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);
const isLocalHost = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h);
const CANONICAL_HOST = String(process.env.PUBLIC_HOST || [...ALLOWED_HOSTS][0] || 'rexpad.fly.dev');
function originOf(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const bare = raw.replace(/:\d+$/, '');
  if (isLocalHost(raw)) return `http://${raw}`;
  const host = (ALLOWED_HOSTS.has(raw) || ALLOWED_HOSTS.has(bare)) ? raw : CANONICAL_HOST;
  return `https://${host}`;
}
/** Browsers always send Origin on a WebSocket upgrade; a forged one is not reachable from a page. */
function originAllowed(origin) {
  if (!origin) return true;              // non-browser clients (tests, bots, native apps)
  let h; try { h = new URL(origin).host.toLowerCase(); } catch { return false; }
  return isLocalHost(h) || ALLOWED_HOSTS.has(h) || ALLOWED_HOSTS.has(h.replace(/:\d+$/, ''));
}

/**
 * Per-IP rate limit on /api/*. The audit scraped holder lists and the trade feed at an unlimited
 * rate (F8); blockchain data is public but handing it over in bulk, sorted and joined, is a
 * different thing. A plain sliding window — generous enough that a human clicking around never
 * sees it, tight enough that a scraper does.
 */
// 240/min is roughly 48 page loads a minute from a single address. A scraper walking every token
// wants orders of magnitude more; an office or a mobile carrier sharing one NAT address does not.
const RATE_MAX = Number(process.env.RATE_MAX || 240);     // requests
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const hits = new Map();   // ip -> number[] (timestamps)
setInterval(() => { const cut = Date.now() - RATE_WINDOW_MS; for (const [ip, ts] of hits) { const keep = ts.filter((t) => t > cut); if (keep.length) hits.set(ip, keep); else hits.delete(ip); } }, RATE_WINDOW_MS).unref?.();
// Loopback is exempt by default: in production every request arrives through Fly's edge with a real
// client IP, so nothing legitimate is ever 127.0.0.1 — while the test suites, which hammer the local
// server far harder than any user would, are not fighting the limiter. Set RATE_LOOPBACK=1 to
// include it, which is how the limiter itself is tested.
const RATE_LOOPBACK = process.env.RATE_LOOPBACK === '1';
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function rateLimited(req) {
  const ip = String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!ip) return false;
  if (isLoopback(ip) && !RATE_LOOPBACK) return false;
  const now = Date.now(), cut = now - RATE_WINDOW_MS;
  const ts = (hits.get(ip) || []).filter((t) => t > cut);
  ts.push(now); hits.set(ip, ts);
  return ts.length > RATE_MAX;
}
const readBody = (req, max = 2_500_000) => new Promise((r) => { let s = '', big = false; req.on('data', (c) => { if (big) return; s += c; if (s.length > max) { big = true; s = ''; } }); req.on('end', () => { if (big) return r({ __tooLarge: true }); try { const v = JSON.parse(s || '{}'); r(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { r({}); } }); req.on('error', () => r({})); });
const cleanText = (s, n) => String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n);
const cleanUrl = E.cleanLink;
const short = (w) => w.slice(0, 4) + '…' + w.slice(-4);
const nameOf = (w) => db.prepare('SELECT name FROM wallets WHERE wallet=?').get(w)?.name || short(w);
/**
 * A wallet's public identity. Always answers, even for a wallet that has never set anything up, so
 * that every caller can render a profile without first checking whether one exists — `named` is
 * what distinguishes a real profile from the fallback.
 */
const profileOf = (w) => {
  const r = db.prepare('SELECT name, bio, avatar, x, telegram, website, created_at, profile_at FROM wallets WHERE wallet=?').get(w) || {};
  // `setup` is the welcome-screen trigger, NOT `named`: a handle can arrive without the person ever
  // having been through setup (a paper demo wallet is given one on creation), and showing somebody a
  // first-run screen they already completed is worse than not showing it at all.
  return { wallet: w, name: r.name || short(w), named: !!r.name, setup: !!r.profile_at, bio: r.bio || '', avatar: r.avatar || null,
    x: r.x || '', telegram: r.telegram || '', website: r.website || '', since: r.created_at || null, profileAt: r.profile_at || null };
};
/** A handle is the one profile field other people are addressed by, so it is the one with rules. */
const HANDLE_RESERVED = /^(forge|admin|team|dev|mod|rex|support|official|staff|null|system)/i;
const cleanHandle = (v) => cleanText(v, 16).replace(/[^A-Za-z0-9_]/g, '');
const handleTaken = (name, wallet) => !!db.prepare('SELECT 1 FROM wallets WHERE lower(name)=lower(?) AND wallet<>?').get(name, wallet);
/**
 * A social is stored as the HANDLE, never as a URL. The site renders the link itself, so there is no
 * field anyone can put an arbitrary destination in — a free-text link on a public profile is an open
 * redirect and a phishing surface, and pasting a full profile URL still does the right thing here.
 */
const cleanHandleField = (v) => cleanText(v, 32).replace(/^.*?(?:twitter\.com|x\.com|t\.me)\//i, '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');

// ---------- websocket
const wss = new WebSocketServer({ noServer: true });
const clients = new Map(); // ws -> { wallet, mint }
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = (o, mintOnly = null) => { const s = JSON.stringify(o); for (const [ws, st] of clients) if (ws.readyState === 1 && (!mintOnly || st.mint === mintOnly)) ws.send(s); };
wss.on('error', (e) => warn('wss', e.message));
wss.on('connection', (ws, req) => {
  ws.on('error', (e) => { warn('ws', e.code || e.message); try { ws.terminate(); } catch {} });
  // F4: the session token used to ride in the query string, which put it in every access log, proxy
  // log and browser history entry. The client now sends {type:'auth'} once the socket is open, and
  // nothing here reads ?token= any more — so an old link cannot leak one either.
  const st = { wallet: null, mint: null };
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  clients.set(ws, st);
  send(ws, { type: 'hello', online: clients.size, nextEpochAt: E.nextEpochAt(), epochMs: cfg.epochMs });
  ws.on('message', (raw) => {
    if (raw.length > 512) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m) return;
    if (m.type === 'sub') st.mint = typeof m.mint === 'string' && m.mint.length < 64 ? m.mint : null;
    else if (m.type === 'auth') st.wallet = typeof m.token === 'string' ? walletFromToken(m.token) : null;
  });
  ws.on('close', () => clients.delete(ws));
});
/**
 * A cp-amm TxBuilder, turned into something a browser wallet can sign.
 *
 * ⛔ THE POSITION NFT KEYPAIR HAS TO SIGN, and it is generated server-side because the position does
 * not exist until this transaction lands. It is a throwaway identity for one account, never a wallet
 * and never anything that holds value — but leave it out of the signature set and the deposit fails
 * on chain after the depositor has approved it.
 */
async function packLpTx(builder, owner, extraSigners = []) {
  const { PublicKey } = await import('@solana/web3.js');
  const tx = typeof builder?.transaction === 'function' ? await builder.transaction() : builder;
  const { blockhash } = await CH.conn().getLatestBlockhash('confirmed');
  tx.feePayer = new PublicKey(owner);
  tx.recentBlockhash = blockhash;
  for (const kp of extraSigners) tx.partialSign(kp);
  return {
    tx: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
  };
}
function drainEvents() {
  while (E.events.length) {
    const ev = E.events.shift();
    if (ev.type === 'trade') {
      ev.who = nameOf(ev.wallet);
      // ⛔ ENRICH ONCE, HERE. Four code paths push trade events — our own buy and sell, fair-open
      // fills, the DBC indexer — and every one of them would otherwise have to work out the USD
      // size and whether the buyer is new. The browser cannot do either: it has no quote-price
      // table and no trade history. This is the single point every trade already passes through.
      ev.usd = (Number(ev.quote) || 0) * usdOf(ev.quoteSymbol);
      if (ev.side === 'buy') { try { ev.firstBuy = E.isFirstBuy(ev.mint, ev.wallet, ev.ts); } catch { ev.firstBuy = false; } }
    }
    if (ev.type === 'yield') ev.top = ev.top.map((p) => ({ ...p, who: nameOf(p.wallet) }));
    broadcast(ev);
  }
}
setInterval(drainEvents, 200);
setInterval(() => { for (const [ws] of clients) { if (ws.isAlive === false) { try { ws.terminate(); } catch {} clients.delete(ws); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 30_000);
// Paper-mode cranks only. In on-chain mode the program is the source of truth and the chain crank
// below does both jobs — running these as well makes the two fight over every row: the engine
// settles a window locally, the indexer rewrites it back to fairopen from chain, and round it goes.
if (!CH.enabled()) {
  setInterval(() => { try { E.settleDue(); } catch (e) { warn('settle', e.message); } }, 500);
}
// ⛔ THE EPOCH LOOP MUST RUN ON MAINNET TOO, and it did not.
// Both were gated off together on the reasoning that the on-chain indexer does the same jobs — true
// of SETTLING a Fair Open on our own curve, and not true of paying an epoch at all. The result was
// that on mainnet no payout ever ran: "Next payout" sat at 00:00 for ever and holder rewards could
// never leave the bucket however much was claimed into it. Settling stays gated, because that is
// the one the indexer really does duplicate and the two rewrite each other's rows; paying does not.
setInterval(() => {
  try {
    if (Date.now() >= E.nextEpochAt()) {
      E.runEpoch();
      broadcast({ type: 'epoch', nextEpochAt: E.nextEpochAt() });
      // "Tell it to update each epoch please. All data accurate like Santa." — Elio, 7 Oct.
      // The burn figures are the ones the team watches, and until now they only moved when somebody
      // happened to load the page after a ten-minute cache had expired.
      RW.refreshAll({ force: true }).catch((e) => warn('rewards refresh', e.message));
      // Pick the NEXT epoch's dividend asset right after this one has paid, so each pick has a
      // whole epoch to land before it is spent. Deliberately not awaited and deliberately not
      // inside runEpoch: that function is synchronous, does its work in one transaction, and a
      // model call cannot be awaited in the middle of one. If this fails the coin simply keeps
      // paying the asset it was already paying.
      AI.dividendPass().catch((e) => warn('ai dividend', e.message));
    }
  }
  catch (e) { warn('epoch', e.message); }
}, 1000);
// …and on a floor of five minutes between epochs, so the panel is never materially behind the chain
// even on a long epoch. Three small reads; the expensive one has its own 30s ceiling inside.
setInterval(() => { RW.refreshAll().catch(() => {}); }, 5 * 60_000);
// ⛔ AND ON ITS OWN SHORT TIMER, which is not redundant with the one above. The epoch fires hourly,
// so a coin launched at ten past would sit for fifty minutes with no asset chosen and pay its quote
// on its first epoch — while the card that launched it said a model picks the asset. `dividendPass`
// only calls a model for a coin whose pick is actually due, so running it often costs nothing for
// coins that already have one.
setInterval(() => { AI.dividendPass().catch((e) => warn('ai dividend', e.message)); }, 5 * 60_000);
setInterval(() => broadcast({ type: 'stats', stats: E.globalStats(), online: clients.size }), 5000);
refreshPrices().catch(() => {}); setInterval(() => refreshPrices().catch(() => {}), 60_000);
/**
 * ⛔ ASK THE CHAIN WHICH PAIRS CAN ACTUALLY BE LAUNCHED, AND KEEP ASKING.
 *
 * Elio picked SUPER INU as a pair, filled the form, signed nothing and got a paragraph about
 * Meteora token badges; then he did it again with ALLINU. Both refusals were correct — DBC will not
 * take a transfer-fee Token-2022 mint as a quote without a badge Meteora has not issued — and both
 * were delivered at the last possible moment, by a form that had offered him the pair in the first
 * place.
 *
 * Deliberately NOT a hardcoded deny-list. Meteora can badge a mint any day, and a list in the
 * source would keep refusing the pair for as long as nobody remembered to delete the line. Six
 * hours is far more often than badges appear and costs about thirty RPC reads.
 *
 * It runs detached and the first sweep is a minute in: a launch form that cannot open until an RPC
 * answers is worse than one that is briefly optimistic about four pairs out of thirty.
 */
/**
 * ⛔ REMEMBER THE ANSWER. A sweep needs about thirty chain reads, and the first thing it met in
 * production was the breaker above: with the RPC key exhausted every read failed, every symbol was
 * left alone (which is right — an unreachable mint must not empty the launch form) and the sweep
 * produced nothing at all. A gate that only works when the chain is healthy is not a gate.
 *
 * Whether a mint carries a transfer fee and whether Meteora has badged it are both stable facts, so
 * one successful sweep is worth keeping: it is applied at boot before any RPC call is made, and a
 * sweep that fails changes nothing. Retried every fifteen minutes until one lands, every six hours
 * after that.
 */
let _topup = { at: 0, data: null, inflight: null };
/** The plan if one is already computed and fresh enough to show; null while it is still working. */
const cachedTopupReady = () => (_topup.data && Date.now() - _topup.at < 120_000 ? _topup.data : null);
async function cachedTopupPlan({ fresh = false } = {}) {
  const MET = await import('./lib/meteora.mjs');
  const { topupPlan } = await import('./lib/topup.mjs');
  const run = async () => {
    const plan = await topupPlan({ conn: CH.conn(), db, MET });
    _topup = { at: Date.now(), data: plan, inflight: null };
    return plan;
  };
  if (fresh) return run();
  if (_topup.data && Date.now() - _topup.at < 120_000) return _topup.data;
  // One computation at a time: two admins opening the page must not double the chain work.
  if (!_topup.inflight) _topup.inflight = run().catch((e) => { _topup.inflight = null; throw e; });
  return _topup.inflight;
}

const BADGE_KEY = 'badge_blocks';
function loadBadgeBlocks() {
  try {
    const v = db.prepare('SELECT v FROM meta WHERE k=?').get(BADGE_KEY)?.v;
    if (!v) return;
    const n = setBadgeBlocks(JSON.parse(v));
    if (n) log(`badge blocks from last sweep: ${n} quote asset(s) cannot be launched against`);
  } catch (e) { warn('badge blocks', e.message); }
}
loadBadgeBlocks();

let badgeTimer = null;
async function sweepBadges() {
  if (cfg.sim || CLUSTER !== 'mainnet') return;
  let ok = false;
  try {
    const { badgeSweep } = await import('./lib/meteora.mjs');
    // ⛔ AS BACKGROUND WORK. This walks every quote asset serially — 62 of them, a read or two
    // each — and when it fails it comes back every 15 minutes, which is to say exactly when the
    // chain is already unwell. Run at foreground priority it competes with launchers for the rate
    // limiter and for the breaker's single recovery probe, and the person who loses that race is
    // told "Solana is rate-limiting every endpoint right now" over the launch button. Julz, 24 Oct.
    // `background()` exists for timers and sweeps; refreshDbcPools, the indexer and the decimals
    // warm-up all use it, and this was the one sweep that did not.
    const verdicts = await CH.background(() => badgeSweep(CH.conn(), quoteList()));
    // An empty result means the chain never answered, not that every pair is fine. Keep what we had.
    if (Object.keys(verdicts).length) {
      ok = true;
      const n = setBadgeBlocks(verdicts);
      db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
        .run(BADGE_KEY, JSON.stringify(verdicts));
      log(`badge sweep: ${n} of ${Object.keys(verdicts).length} quote assets cannot be launched against`);
    } else warn('badge sweep', 'the chain answered nothing — keeping the previous verdicts');
  } catch (e) { warn('badge sweep', e.message); }
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(sweepBadges, ok ? 6 * 3600_000 : 15 * 60_000);
}
badgeTimer = setTimeout(sweepBadges, 60_000);

/**
 * The same question asked of the transfer-hook catalogue: is each rule's program really there?
 *
 * ⛔ THIS IS NOT PARANOIA. Hooked publishes "Anti-bundle" with the address
 * AsqN4BA2cGmzbajL5rdg8rmfAsWs2K4TBS7Eqa8eLaY8, and that account does not exist on mainnet.
 * Offering it would hand a coin — immutably, for the life of the mint — a hook program that is not
 * there. Rules are verified on the same persist-and-retry pattern as the quote badges, and for the
 * same reason: a verdict that only survives while the RPC is healthy is not a verdict.
 */
const HOOK_KEY = 'hook_blocks';
let hookTimer = null;
async function sweepHooks() {
  if (cfg.sim || CLUSTER !== 'mainnet') return;
  let ok = false;
  try {
    const HOOK = await import('./lib/hooked.mjs');
    const verdicts = await HOOK.hookSweep(CH.conn());
    if (Object.keys(verdicts).length) {
      ok = true;
      const n = HOOK.setHookBlocks(verdicts);
      db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
        .run(HOOK_KEY, JSON.stringify(verdicts));
      log(`hook sweep: ${n} of ${Object.keys(verdicts).length} rules are not usable`);
    } else warn('hook sweep', 'the chain answered nothing — keeping the previous verdicts');
  } catch (e) { warn('hook sweep', e.message); }
  clearTimeout(hookTimer);
  hookTimer = setTimeout(sweepHooks, ok ? 6 * 3600_000 : 15 * 60_000);
}
(async () => {
  try {
    const v = db.prepare('SELECT v FROM meta WHERE k=?').get(HOOK_KEY)?.v;
    if (v) {
      const HOOK = await import('./lib/hooked.mjs');
      const n = HOOK.setHookBlocks(JSON.parse(v));
      if (n) log(`hook blocks from last sweep: ${n} rule(s) unusable`);
    }
  } catch (e) { warn('hook blocks', e.message); }
})();
hookTimer = setTimeout(sweepHooks, 90_000);

// ⛔ A COIN ON METEORA HAS NO PRICE UNLESS SOMETHING GOES AND READS IT.
// Our own trade table never sees a DBC swap, and mcap is `price * supply`, so every such coin read
// $0 market cap, $0 liquidity and 0% curve on every board — while $BITE had traded 320 times and
// held 12.8M REX. This is the loop that keeps them honest. One account read per pool, so the cost
// is a handful of calls a minute, and a pool that will not answer simply keeps its last figures
// rather than being zeroed.
let _lastPoolPass = 0;
// Measured from mainnet launches ($BITE 0.0221, $ZECRET 0.0266) with headroom for a pricier one.
// Rent, not a fee: Solana charges it for the mint, the metadata account and the pool's accounts.
const LAUNCH_SOL_FLOOR = 0.035;
const _lastHolderMirror = new Map();
const _lastPoolTick = new Map();
async function refreshDbcPools() {
  if (!CH.enabled()) return;
  // ⛔ DON'T WALK 111 TOKENS TO BE REFUSED 111 TIMES. Background work no longer takes the breaker's
  // recovery probe, which is right — but without this the sweep still looped every pool on every
  // tick while paused, collecting a refusal per token and writing a log line for each. Measured on
  // the live box: 49 poolStatsOf refusals and 27 quote-decimals refusals inside one 80-line window,
  // all of them this loop discovering the same thing over and over. Nothing is lost by sitting the
  // tick out; the next one picks the pools up.
  if (CH.rpcPaused()) return;
  const every = CH.isPublicRpc() ? 30_000 : 10_000;
  if (Date.now() - _lastPoolPass < every - 500) return;
  _lastPoolPass = Date.now();
  // ⛔ SELECT THE BUCKET COLUMNS TOO. `bucketsOf()` reads holder_bps/vault_bps/burn_bps/buyback_bps,
  // and a column that was not selected is `undefined`, which it treats as 0 — so the accruing holder
  // share computed as zero and the panel went on reading $0 even after it was wired to the pool.
  // A partial SELECT feeding a function that expects a whole row fails silently and plausibly.
  const rows = db.prepare("SELECT mint,dbc_pool,last_trade_at,dbc_config,quote,quote_mint,holder_bps,vault_bps,burn_bps,buyback_bps FROM tokens WHERE venue='dbc' AND dbc_pool IS NOT NULL AND status!='graduated'").all();
  if (!rows.length) return;
  const MET = await import('./lib/meteora.mjs');
  const IDX = await import('./lib/dbcindex.mjs');
  for (const t of rows) {
    // ⛔ AND CHECK AGAIN HERE, NOT ONLY BEFORE THE LOOP — the same mistake the breaker itself
    // documents one layer down. A tick that starts while the endpoint is answering keeps walking
    // all 111 pools as the breaker opens underneath it, collecting a refusal and a log line for
    // every pool after the first failure. The bail above took quote-decimal refusals from 27 to 10
    // in a log window and left poolStatsOf at 40, which is precisely this: one sweep discovering
    // the outage a hundred more times. Stop the pass; the next one resumes.
    if (CH.rpcPaused()) break;
    // ⛔ POLLING EVERY POOL EVERY TEN SECONDS IS WHAT BURNS THE CREDITS. Twenty-three live coins at
    // two reads each, around the clock, is several requests a second forever — and almost all of it
    // asks a coin that has not traded in hours whether its price has changed. The board has to
    // track the TRADING, which means a coin being traded right now deserves ten seconds and a coin
    // nobody has touched since yesterday does not.
    //
    // Tiered off last_trade_at, which the indexer already maintains, so a coin speeds up the moment
    // somebody trades it and slows down on its own afterwards. No new state and nothing to reset.
    // ⛔ WIDENED, NOW THAT A TRADE SETS THE PRICE ITSELF. The tiers below used to carry the whole
    // board: `tokens.price` was written here and nowhere else, so an actively traded coin needed a
    // ten-second poll or its price visibly lagged. The indexer now writes the price from each trade
    // it records, at no RPC cost and from an actual execution, so this sweep is a BACKSTOP — it
    // exists for reserves, holder counts and coins nobody is trading, none of which move in ten
    // seconds. A coin being traded right now is fresher than it was before this change, not staler,
    // because it updates per trade instead of per tick.
    //
    // The owner chose a slower board over a larger RPC plan. These are the numbers that buys.
    const quiet = Date.now() - (Number(t.last_trade_at) || 0);
    const due = quiet < 15 * 60_000 ? 30_000            // traded in the last quarter hour: twice a minute
      : quiet < 6 * 3600_000 ? 5 * 60_000               // traded today: every five minutes
        : 30 * 60_000;                                  // dormant: every half hour
    if (due && Date.now() - (_lastPoolTick.get(t.mint) || 0) < due) continue;
    _lastPoolTick.set(t.mint, Date.now());
    // ⛔ FROM THE MINT, NOT FROM THE TABLE, AND NEVER FROM A `?? 6`. The table is hand-typed and had
    // STONK and ZCAT wrong by a factor of a thousand; the chain cannot be wrong about its own mint.
    // A quote we cannot read is skipped rather than priced on a guess.
    const dec = t.quote_mint ? await MET.quoteDecimalsOf(CH.conn(), t.quote_mint) : null;
    if (!Number.isInteger(dec)) continue;
    const st = await MET.poolStatsOf(CH.conn(), t.dbc_pool, { quoteDecimals: dec });
    if (!st || !(st.price > 0)) continue;
    // ⛔ WHO ACTUALLY HOLDS THIS COIN, into the table the epoch reads. Without it `rewardSnapshot`
    // sees an empty `holdings` for every Meteora launch and no epoch can ever pay — which is why
    // $BITE had 56,566 REX of holder money banked, 16 holders on chain and 0 epochs. Once every
    // few minutes is plenty: the snapshot is taken at the epoch, not per trade, and this is a
    // getProgramAccounts scan per coin.
    // ⛔ AND THIS ONE IS A getProgramAccounts SCAN PER COIN, the most expensive call there is.
    // Twenty-three of them every four minutes, for ever, is most of the bill — and a coin that has
    // not traded since the last scan has exactly the same holders it had then. Skip it unless
    // something has actually moved.
    // ⛔ HOLDERS CHANGE FROM TRADES WE NEVER SEE, so a refresh driven only by trades we DID see
    // leaves ghosts on the books for ever.
    //
    // These coins are on Meteora: they trade on DexScreener, on Jupiter, in any terminal. A holder
    // who sells somewhere else produces no row in our trades table, last_trade_at does not move,
    // `tradedSince` stays false, and the mirror never runs again for that coin. Measured on
    // mainnet: 23 of 82 on-chain holdings — 28% — were positions the wallet no longer held. They
    // show in portfolios, and they are in the table the reward epoch reads, so every ghost was
    // diluting the people who actually still hold.
    //
    // A trade we saw still refreshes immediately; the heartbeat is the floor underneath it, for the
    // sales we are never told about.
    const mirroredAt = _lastHolderMirror.get(t.mint) || 0;
    const tradedSince = (Number(t.last_trade_at) || 0) > mirroredAt;
    const stale = Date.now() - mirroredAt > 30 * 60_000;
    if (Date.now() - mirroredAt > 4 * 60_000 && (tradedSince || stale || !mirroredAt)) {
      _lastHolderMirror.set(t.mint, Date.now());
      IDX.mirrorHolders(CH.conn(), t, MET).catch((e) => warn('holder mirror', `${t.mint.slice(0, 6)}: ${e.message}`));
    }
    const target = st.config ? await MET.migrationThresholdOf(CH.conn(), st.config, dec) : null;
    db.prepare('UPDATE tokens SET price=?, real_quote=?, raise_target=COALESCE(?, raise_target) WHERE mint=?')
      .run(st.price, st.quoteReserve, target, t.mint);
    // ⛔ HOLDER REWARDS MUST SHOW WHAT IS ACCRUING, NOT WHAT HAS BEEN SWEPT.
    // The reward panel read `yield_pool`, a database bucket that only fills when the fee crank
    // claims — so it said "$0" while $245.81 of real fees sat on $BITE's pool earning for holders.
    // That reads as "this coin pays nothing", which is the opposite of the truth. The pool is the
    // authority: its unclaimed partner fee, times the holder bucket, is what holders are owed right
    // now whether or not anyone has swept it yet.
    try {
      const FEES = await import('./lib/fees.mjs');
      const pf = await MET.partnerFeesOf(CH.conn(), t.dbc_pool);
      if (pf) {
        const b = FEES.bucketsOf(t);
        const pending = (Number(pf.quote) / 10 ** dec) * (b.holder / 10_000);
        db.prepare('UPDATE tokens SET pending_yield=? WHERE mint=?').run(pending, t.mint);
      }
    } catch (e) { warn('dbc pending yield', e.message); }
    // The swaps themselves: volume, the trade tape and the trade count, which no other part of this
    // server ever sees for a Meteora coin. Walked in pages so the public RPC is not asked for a
    // pool's whole history at once.
    try { await IDX.indexPool(CH.conn(), t, MET, CH); } catch (e) { warn('dbc index', e.message); }
    // A coin indexed before candles were written has a tape and no chart, and its history is never
    // walked again. Rebuild from the trades, which are the source of truth either way. No-op once done.
    try { const n = IDX.backfillCandles(t.mint); if (n) log(`rebuilt ${n} candles for ${t.mint.slice(0, 8)}`); } catch (e) { warn('candle backfill', e.message); }
    // Holders change slowly and the count is the most expensive call here, so it runs on its own
    // slower beat rather than every pass.
    //
    // ⛔ AND IT IS TIERED TOO, BECAUSE THIS IS A getProgramAccounts SCAN. A flat five minutes per
    // coin across 111 coins is ~22 whole-program scans a minute — low in call COUNT and the single
    // largest thing on the bill, because Helius prices by credit and a program scan is worth many
    // ordinary reads. It is also the call that has taken the public RPC down before. A coin nobody
    // has traded in a week does not need its holders recounted every five minutes; one being traded
    // now does, because its holder count is on screen and changing.
    const holderDue = quiet < 15 * 60_000 ? 300_000       // traded recently: the old five minutes
      : quiet < 6 * 3600_000 ? 30 * 60_000                // traded today: every half hour
        : 6 * 3600_000;                                   // dormant: four times a day
    if (Date.now() - (holderSeen.get(t.mint) || 0) > holderDue) {
      holderSeen.set(t.mint, Date.now());
      const h = await IDX.countHolders(CH.conn(), t.mint, [t.dbc_pool]);
      // null means the RPC refused — leave the last known figure rather than claiming nobody holds it.
      if (h !== null) db.prepare('UPDATE tokens SET holders=? WHERE mint=?').run(h, t.mint);
    }
  }
}
const holderSeen = new Map();
if (CH.enabled()) {
  CH.checkRpcConfig();
  // A hand-typed decimals table is a hand-typed money bug waiting to happen. Checked once at boot
  // and every six hours, because a pair can be added to the table at any time.
  const auditDecimals = () => auditQuoteDecimals(CH.conn()).catch((e) => warn('quotes', e.message));
  setTimeout(auditDecimals, 20_000);
  setInterval(auditDecimals, 6 * 60 * 60_000);
  // ⛔ AND FILL THE LAUNCH PATH'S CACHE AHEAD OF TIME. The audit above answers "is the table
  // right?"; this answers "can a launch get the decimals at the moment it needs them?", which is a
  // different question and the one that cost Fco a DOPE launch: `decimalsOf` met a single 429 and
  // the route refused rather than size a curve on a guess. The refusal was right; needing a live
  // read at that instant was not. Reading every quote once, in one batched call, means the launch
  // hits a cache that was filled FROM THE CHAIN rather than a network call that can fail.
  //
  // Backgrounded, so it queues behind user-facing work instead of competing with it.
  const warmQuoteDecimals = () => CH.background(async () => {
    const LPW = await import('./lib/lp.mjs');
    const n = await LPW.warmDecimals(CH.conn(), Object.values(QUOTES).map((q) => q.mint));
    log(`🔢 decimals cached for ${n}/${Object.keys(QUOTES).length} quote assets`);
  }).catch((e) => warn('warm decimals', e.message));
  setTimeout(warmQuoteDecimals, 8_000);
  setInterval(warmQuoteDecimals, 6 * 60 * 60_000);
  // Shape first, then the only question that matters: will it serve us? Once at boot, and hourly
  // after that, because a key can be revoked or run out of credits at any point in a long uptime.
  CH.probeRpc().catch(() => {});
  setInterval(() => { CH.probeRpc().catch(() => {}); }, 60 * 60_000);
}
// ⛔ A CRANK NOBODY RUNS IS A CRANK THAT DOES NOT EXIST. Claiming was a command someone had to type,
// so nobody did: $BITE accrued $245 of claimable fees while its reward panel read $0. It runs itself
// now. Without FEE_CLAIMER_KEY it does nothing at all and says so once, rather than failing on a
// timer — the key is a signing key and is the operator's to provide.
if (CH.enabled()) {
  const CRANK = await import('./lib/feecrank.mjs');
  const problem = CRANK.claimerProblem();
  if (problem) {
    warn('fee crank', `⛔ ${problem}`);
  } else {
    const pass = async () => {
      try {
        const MET = await import('./lib/meteora.mjs');
        const r = await CRANK.runOnce({ conn: CH.conn(), execute: true, MET });
        if (r.claimed || r.resumed || r.failed) log(`fee crank claimed ${r.claimed} resumed ${r.resumed} failed ${r.failed}`);
      } catch (e) { warn('fee crank', e.message); }
    };
    setTimeout(pass, 20_000);              // let the pool refresher populate first
    setInterval(pass, 5 * 60_000);
  }
}
// ⛔ ANY SEND THAT WAS SIGNED BUT NEVER RESOLVED IS RESOLVED HERE, at startup and then hourly. A
// crash between recording a signature and confirming it leaves money reserved in the database and
// an unknown outcome on chain; this asks the chain which it was and either settles it or puts the
// reservation back. Without it, one bad restart silently freezes a holder's balance for ever.
/** The last automatic distribution: when it ran and what it did. Served by /api/health. */
let autoPayout = null;
let autoHolders = null;
if (CH.enabled()) {
  const PAYOUT = await import('./lib/payout.mjs');
  const sweep = async () => {
    try {
      const r = await PAYOUT.reconcile({ conn: CH.conn() });
      if (r.open) log(`payout reconcile: ${r.settled} settled, ${r.restored} restored of ${r.open} open`);
    } catch (e) { warn('payout reconcile', e.message); }
  };
  setTimeout(sweep, 25_000);
  setInterval(sweep, 60 * 60_000);
  // The protocol's own distribution does NOT run on a timer by default. It moves the treasury, so
  // it is a deliberate act: `tools/payout.mjs --execute`, or POST /api/admin/payouts/run from one
  // of the wallets the chain names. Set PAYOUT_AUTO=1 to have it run itself every six hours.
  // ⛔ UNDISTRIBUTED INCOME MUST NEVER AGAIN ACCUMULATE WITHOUT SOMEBODY BEING TOLD.
  // Separate from PAYOUT_AUTO on purpose: this one only ever SAYS something. Moving the treasury
  // stays a decision; noticing that it needs moving does not.
  const alarm = async () => {
    try {
      const PO = await import('./lib/payout.mjs');
      const due = PO.protocolPending();
      if (due.usd < Number(process.env.PAYOUT_ALARM_USD || 25)) return;
      const days = due.sinceMs ? (due.sinceMs / 86_400_000).toFixed(1) : '?';
      warn('UNDISTRIBUTED INCOME', `$${due.usd.toFixed(2)} of protocol fees is sitting in rex_pot across`,
        `${due.assets.length} asset(s) — ${due.assets.slice(0, 4).map((a) => `${a.total.toFixed(4)} ${a.quote}`).join(', ')}`,
        `· last distribution was ${days}d ago · run \`node tools/payout.mjs --execute\` or set PAYOUT_AUTO=1`);
    } catch (e) { warn('payout alarm', e.message); }
  };
  setTimeout(alarm, 45_000);
  setInterval(alarm, 6 * 60 * 60_000);
  if (process.env.PAYOUT_AUTO === '1') {
    log('💸 automatic protocol distribution is ON — every 6h, starting 90s from now');
    const run = async () => {
      try {
        const r = await PAYOUT.payProtocol({ conn: CH.conn(), CH, execute: true });
        if (r.sent || r.failed) log(`protocol payout: ${r.sent} sent, ${r.failed} failed, ${r.skipped} under the dust floor`);
        // ⛔ AND THE HOLDERS. This loop paid the treasury and nobody else for its whole life: 307
        // holder payout rows worth 85,301 had been allocated and not one had ever been sent,
        // because payHolder is pull-based and no screen in the product offered a holder a pull.
        try {
          const h = await PAYOUT.payAllHolders({ conn: CH.conn(), CH, execute: true });
          if (h.sent || h.failed) log(`holder payout: ${h.sent} sent, ${h.failed} failed, ${h.skipped} dust, ${h.remaining} wallets left for the next pass`);
          autoHolders = { at: Date.now(), ...h };
        } catch (e) { autoHolders = { at: Date.now(), error: e.message }; warn('holder payout', e.message); }
        // ⛔ A RUN THAT SENT NOTHING STILL HAPPENED, and the difference between "it ran and there
        // was nothing to send" and "it never ran" is invisible in the log, because the line above
        // only prints when money moved. That is not good enough for a loop that moves the treasury
        // unattended: with only dust in the pot, a dead timer and a healthy one look identical.
        autoPayout = { at: Date.now(), sent: r.sent, failed: r.failed, skipped: r.skipped, error: r.error || null };
      } catch (e) {
        autoPayout = { at: Date.now(), sent: 0, failed: 0, skipped: 0, error: e.message };
        warn('protocol payout', e.message);
      }
    };
    setTimeout(run, 90_000);
    setInterval(run, 6 * 60 * 60_000);
  }
}
// ⛔ BACKGROUND, so it yields the breaker's recovery probe to anyone actually waiting. This loop
// runs every 10s and was taking that one slot almost every time the breaker opened, which is why a
// launcher loading the form during a pause got refused while a pool sweep tested the endpoint on
// their behalf.
CH.background(() => refreshDbcPools()).catch((e) => warn('dbc pools', e.message));
// The free public RPC cannot be polled hard, so on it this is a slow heartbeat. On a paid endpoint
// the same loop can run three times as often, which is the difference between a board that tracks
// the trading and one that visibly trails it. Checked per tick, so setting the secret takes effect
// without a deploy.
setInterval(() => CH.background(() => refreshDbcPools()).catch((e) => warn('dbc pools', e.message)), 10_000);

// ---------- helpers
const lastAct = new Map(); // `${kind}:${wallet}` -> ts
/**
 * ⛔ A THROTTLE KEYED ON A STRING THE CALLER CHOSE IS NOT A THROTTLE.
 *
 * Everything under /api/chain/ takes its wallet from `body.wallet` and validates it only as
 * well-formed — the signature is what actually authorises a transaction, so the server never needed
 * to know who was asking. That is sound for safety (a transaction built for somebody else's key is
 * useless without their signature) and useless for rate limiting: `throttle('faucet', w, 60_000)`
 * means one faucet per wallet per minute, and a caller who changes the string gets another one
 * immediately. The same held for every tx builder, each of which costs RPC reads — which is real
 * money on a metered endpoint, and the thing that ran this project out of credits twice today.
 *
 * Both limits apply. The wallet key is the one that helps an honest user (it stops a double-click
 * submitting twice); the IP key is the one that bounds abuse. The IP window is deliberately looser,
 * because several real people do share an address — a Telegram in-app browser, an office, a phone
 * network — and throttling them as one person is its own bug.
 */
function throttled(kind, wallet, req, msWallet, msIp = null) {
  if (!throttle(kind, wallet, msWallet)) return true;
  return msIp ? !throttle(kind + ':ip', ipOf(req), msIp) : false;
}
const ipOf = (req) => String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon').split(',')[0].trim();
function throttle(kind, wallet, ms) { const k = kind + ':' + wallet; const t = Date.now(); if (t - (lastAct.get(k) || 0) < ms) return false; lastAct.set(k, t); if (lastAct.size > 50_000) lastAct.clear(); return true; }
function auth(req) { const h = req.headers.authorization || ''; const tok = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url, 'http://x').searchParams.get('token'); return { token: tok, wallet: walletFromToken(tok) }; }
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); // no SVG: scriptable
  if (!m) return null;
  const ext = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif', 'svg+xml': 'svg' }[m[1]];
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 1_800_000) throw new Error('Image too large (max 1.8 MB)');
  const file = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(IMG, file), buf);
  return '/img/' + file;
}
/** Paper money on the demo market; the real on-chain balance everywhere else. */
async function quoteBalanceOf(wallet, t) {
  if (cfg.sim) return E.balanceOf(wallet, t.quote);
  if (!CH.enabled() || !t.quote_mint) return null;
  const held = await CH.heldOf(wallet, t.quote_mint);
  return held ? Number(held.spendable) / 10 ** (held.decimals || 6) : null;
}
// ⛔ `quoteBalance` FEEDS THE BUY BOX, SO IT MUST BE MONEY THAT EXISTS.
// It read `E.balanceOf`, which is the SIM market's paper ledger, and that ledger still holds rows
// credited before the faucet was disabled — seven mainnet wallets carrying 5,000,000 paper REX
// each. The coin page therefore advertised "Balance: 5.00M REX" and offered 1M/5M quick-buys
// against money nobody had, and every one of them would have died in simulation. Off SIM the only
// honest source is the chain. `heldOf` returns null when the read fails, which stays null here:
// unknown, never a number somebody might spend against.
async function meOn(wallet, mint) {
  if (!wallet) return null;
  const t = E.getToken.get(mint); const h = E.holdingOf(wallet, mint); const c = E.convictionOf(h.held_since);
  const bid = db.prepare('SELECT amount FROM bids WHERE mint=? AND wallet=?').get(mint, wallet)?.amount || 0;
  // Reward share is pro-rata to balance among holders over the $20 floor — the same snapshot the
  // epoch itself takes, so what the panel shows is what the payout pays.
  const snap = E.rewardSnapshot(mint, 1);
  const mine = snap.eligible.find((x) => x.wallet === wallet);
  return { holding: h.amount, heldSince: h.held_since, cost: h.cost, realized: h.realized, yieldEarned: h.yield_earned,
    tier: c.label, share: mine ? mine.share : 0, belowFloor: h.amount > 0 && !mine, floorQuote: snap.floorQuote,
    bid, quoteBalance: await quoteBalanceOf(wallet, t), balances: cfg.sim ? Object.fromEntries(db.prepare('SELECT asset, amount FROM balances WHERE wallet=?').all(wallet).map((r) => [r.asset, r.amount])) : {} };
}

// ---------- routes
async function api(req, res, p, m) {
  const { token, wallet } = auth(req);
  const body = m === 'POST' ? await readBody(req) : {};
  if (body.__tooLarge) return json(res, 413, { error: 'Payload too large (max 2.5 MB)' });
  const need = () => { if (!wallet) { json(res, 401, { error: 'Sign in with your wallet first' }); return false; } E.ensureWallet(wallet); return true; };
  if (p === '/api/auth/nonce' && m === 'POST') { const w = String(body.wallet || ''); if (!isWallet(w)) return json(res, 400, { error: 'bad wallet' }); const nonce = makeNonce(w); return json(res, 200, { nonce, message: signInMessage(w, nonce) }); }
  if (p === '/api/auth/verify' && m === 'POST') { const { wallet: w, nonce, signature } = body; if (!verifySignature(String(w), String(nonce), String(signature))) return json(res, 401, { error: 'bad signature' }); E.ensureWallet(w); return json(res, 200, { token: createSession(w), wallet: w }); }
  if (p === '/api/auth/demo' && m === 'POST') { // SIM only: paper wallet, no signature — for trying the product without a wallet
    if (!cfg.sim) return json(res, 403, { error: 'demo wallets are only available in SIM mode' });
    const w = (await import('bs58')).default.encode(crypto.randomBytes(32)); E.ensureWallet(w); db.prepare('UPDATE wallets SET name=? WHERE wallet=?').run('demo_' + w.slice(0, 4), w);
    return json(res, 200, { token: createSession(w), wallet: w });
  }
  if (p === '/api/auth/logout' && m === 'POST') { if (token) dropSession(token); return json(res, 200, { ok: true }); }
  // route is unreachable and answers 405 — which the page renders as an empty dashboard.
  // ---- the creator's own fees ------------------------------------------------------------
  // ⛔ WHERE A COIN'S CREATOR FEE LIVES DEPENDS ENTIRELY ON ITS VENUE, and reading the wrong
  // one reports zero while real money sits unclaimed. On our own curve the creator's share
  // accrues into `creator_pot` in this database, because our program splits each swap into five
  // buckets we control. On Meteora it accrues ON THE POOL ACCOUNT and our database never sees
  // it — $REXWEEN had 193.84 REX waiting on it while our `trades` count still said 0.
  // ---- REX Chain's own income -------------------------------------------------------------
  // ⛔ GATED ON THE CHAIN'S OWN ANSWER to "who gets paid". The wallet list is derived from the
  // config account rather than kept in an env var or a constant, because `migrate_config` can move
  // the waterfall on chain — and a gate kept in a second place is a gate that silently stops
  // matching the money it is protecting. An unreadable config CANNOT AUTHORISE: it fails closed.
  // Hand the crown to a coin for a fixed window. Gated on the same wallets as /earnings — derived
  // from the chain's own config, so whoever the protocol pays is who may dub, and an unreadable
  // config authorises nobody.
  // ⛔ ONE ADMIN GATE, DERIVED FROM THE CHAIN. Who may administrate is whoever the config says gets
  // paid — not an env var and not a list in this file, because a gate kept in a second place is a
  // gate that silently stops matching the money. Returns false having ALREADY answered the request.
  const adminOk = async () => {
    if (!need()) return false;
    if (!CH.enabled()) { json(res, 503, { error: 'on-chain mode is off' }); return false; }
    // An explicitly named owner key is allowed without reading the chain at all: being unable to
    // open the admin page because an RPC is sulking is its own kind of broken.
    if (cfg.adminWallets.includes(wallet)) return true;
    const allowed = await CH.protocolWallets();
    if (!allowed) { json(res, 503, { error: 'Could not read the protocol config just now — try again in a moment' }); return false; }
    if (!allowed.has(wallet)) {
      json(res, 403, { error: 'This page is for the wallets REX Chain pays out to, or an owner key. '
        + `This one (${wallet.slice(0, 4)}…${wallet.slice(-4)}) is neither.` });
      return false;
    }
    return true;
  };
  // ---------------------------------------------------------------- the second launch venue
  //
  // Meteora refuses a quote mint that charges a transfer fee, which is five of our pairs including
  // $GP. Raydium's LaunchLab does not. Creating this one account is what turns the venue on; until
  // it exists llEnabled() is false and nothing about the product changes.
  if (p === '/api/admin/launchlab/platform' && (m === 'GET' || m === 'POST')) {
    if (!(await adminOk())) return;
    try {
      const LL = await import('./lib/launchlab.mjs');
      if (m === 'GET') {
        const id = LL.llPlatformId();
        if (!id) { await LL.llRefreshConfigs({ force: true }).catch(() => {}); return json(res, 200, { enabled: false, pairs: LL.llPairs() }); }
        return json(res, 200, { enabled: true, id, platform: await LL.llPlatform({ fresh: true })
          .then((x) => ({ ...x, feeRate: String(x.feeRate), creatorFeeRate: String(x.creatorFeeRate) })) });
      }
      const r = await LL.llCreatePlatform({
        execute: body.execute === true,
        ...(body.feeRate == null ? {} : { feeRate: Number(body.feeRate) }),
        ...(body.creatorFeeRate == null ? {} : { creatorFeeRate: Number(body.creatorFeeRate) }),
      });
      return json(res, 200, r.platform
        ? { ...r, platform: { ...r.platform, feeRate: String(r.platform.feeRate), creatorFeeRate: String(r.platform.creatorFeeRate) } }
        : r);
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ⛔ THE PLAN IS SLOW ENOUGH TO LOOK BROKEN. It reads a pool per launch and simulates a claim per
  // launcher — seconds on a good day, and the panel sat on "Checking who cannot claim…" long
  // enough that the owner reasonably concluded it had hung. Cached for two minutes, refreshed in
  // the background, and the POST always re-derives it fresh because that is the one that spends.
  // ---------------------------------------------------------------- fund the blocked launchers
  //
  // ⛔ THE LIST IS DERIVED HERE, NOT SENT BY THE BROWSER. The owner funded seven launchers by hand
  // from a list I gave them and six were still short, because my figure was the rent for one
  // account when a claim opens two. A hand-copied list of addresses and amounts goes wrong twice,
  // so the amounts are computed from the chain at the moment the button is pressed, and the client
  // may only narrow the set — never name an address or an amount of its own.
  if (p === '/api/admin/topup' && m === 'GET') {
    if (!(await adminOk())) return;
    try {
      // ⛔ ANSWER AT ONCE, EVEN IF THE ANSWER IS "still working". A panel that waits ten seconds on
      // a blank line is a panel the owner reports as broken — which is exactly what happened.
      const ready = cachedTopupReady();
      if (!ready) { cachedTopupPlan().catch((e) => warn('topup', e.message)); return json(res, 200, { computing: true }); }
      const plan = ready;
      return json(res, 200, {
        rows: plan.rows.map((r) => ({ wallet: r.wallet, coins: r.coins, have: r.have, need: r.need, send: r.send, unverified: !!r.unverified })),
        fine: plan.fine.map((r) => ({ wallet: r.wallet, coins: r.coins, have: r.have })),
        total: plan.total, rentPerAccount: plan.perAccount, payerFloor: plan.floor, at: _topup.at,
      });
    } catch (e) { return json(res, 503, { error: `Could not read the chain just now — ${e.message}` }); }
  }
  if (p === '/api/admin/topup' && m === 'POST') {
    if (!(await adminOk())) return;
    try {
      const MET = await import('./lib/meteora.mjs');
      const { buildTopupTx } = await import('./lib/topup.mjs');
      const plan = await cachedTopupPlan({ fresh: true });
      // The caller may narrow the set by address; it may not add one, and it may not set an amount.
      const only = Array.isArray(body.wallets) ? new Set(body.wallets.map(String)) : null;
      const rows = only ? plan.rows.filter((r) => only.has(r.wallet)) : plan.rows;
      if (!rows.length) return json(res, 400, { error: 'Every launcher with fees waiting can already claim — nothing to fund.' });
      const { tx, total, count } = await buildTopupTx({ conn: CH.conn(), from: wallet, rows });
      const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      const why = await MET.explainBeforeSending(CH.conn(), b64, { action: 'top-up' });
      if (why) return json(res, 400, { error: why });
      return json(res, 200, { tx: b64, total, count, wallets: rows.map((r) => ({ wallet: r.wallet, send: r.send, coins: r.coins })) });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/admin/king' && m === 'POST') {
    if (!(await adminOk())) return;
    const mint = String(body.mint || '');
    if (mint && !isWallet(mint)) return json(res, 400, { error: 'bad mint' });
    try {
      const r = E.setKing(mint || null, Number(body.hours) || 24);
      broadcast({ type: 'stats', stats: E.globalStats(), online: clients.size });
      return json(res, 200, { ok: true, king: r, cleared: !mint });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/earnings' && m === 'GET') {
    const who = new URL(req.url, 'http://x').searchParams.get('wallet');
    if (!isWallet(who)) return json(res, 400, { error: 'bad wallet' });
    if (!CH.enabled()) return json(res, 503, { error: 'on-chain mode is off, so there is nothing to report' });
    const allowed = await CH.protocolWallets();
    if (!allowed) return json(res, 503, { error: 'Could not read the protocol config just now — try again in a moment' });
    if (!allowed.has(who)) return json(res, 403, { error: 'This page is for the wallets REX Chain pays out to.' });

    const MET = await import('./lib/meteora.mjs');
    const rows = E.coinsByCreator ? db.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all() : [];
    const coins = [];
    for (const t of rows.slice(0, 80)) {
      const q = Object.values(QUOTES).find((x) => x.symbol === t.quote);
      const dec = q?.decimals ?? 6, usd = usdOf(t.quote);
      let partner = null;                       // null = UNKNOWN, never "nothing owed"
      if (t.venue === 'dbc' && t.dbc_pool) {
        const f = await CH.readWithRetry(() => MET.partnerFeesOf(CH.conn(), t.dbc_pool));
        if (f) partner = { quote: Number(f.quote) / 10 ** dec, base: Number(f.base) / 10 ** 6, rawQuote: String(f.quote), rawBase: String(f.base) };
      }
      // Our own curve keeps the protocol's share in buckets in this database instead.
      const curve = t.venue === 'dbc' ? null
        : { vaultPot: t.vault_pot || 0, vaultPaid: t.vault_paid || 0, rexPot: t.rex_pot || 0, rexPaid: t.rex_paid || 0, burnPot: t.burn_pot || 0, burnPaid: t.burn_paid || 0 };
      coins.push({ mint: t.mint, name: t.name, symbol: t.symbol, image: t.image, quote: t.quote, quoteUsd: usd,
        venue: t.venue || 'rexpad', pool: t.dbc_pool || null, config: t.dbc_config || null,
        trades: t.trades || 0, volume: t.volume || 0, partner, curve });
    }
    const usdOfRow = (c, v) => (v || 0) * (c.quoteUsd || 0);
    const claimableUsd = coins.reduce((a, c) => a + usdOfRow(c, c.partner?.quote) + usdOfRow(c, (c.curve?.vaultPot || 0) + (c.curve?.rexPot || 0)), 0);
    const takenUsd = coins.reduce((a, c) => a + usdOfRow(c, (c.curve?.vaultPaid || 0) + (c.curve?.rexPaid || 0)), 0);
    return json(res, 200, {
      wallet: who, coins, waterfall: await CH.waterfall(),
      feeClaimer: coins.find((c) => c.config) ? await CH.readWithRetry(() => MET.feeClaimerOf(CH.conn(), coins.find((c) => c.config).config)) : null,
      totals: {
        coins: rows.length,
        claimableUsd, takenUsd, earnedUsd: claimableUsd + takenUsd,
        volumeUsd: coins.reduce((a, c) => a + usdOfRow(c, c.volume), 0),
        trades: coins.reduce((a, c) => a + c.trades, 0),
        unknown: coins.some((c) => c.venue === 'dbc' && c.partner === null),
      },
    });
  }
  // ---- the token metadata every wallet, scanner and bot actually reads --------------------
  // ⛔ This URL is written into the mint's metadata at creation and CAN NEVER BE CHANGED — these
  // mints are immutable with a null update authority. If it does not answer, the coin has no image
  // anywhere outside this site, permanently. $BITE and $REXWEEN shipped before this existed and are
  // imageless for good. Keep it cheap, keep it public, and never let it 500.
  if (/^\/api\/meta\/[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(p) && m === 'GET') {
    const mint = p.slice('/api/meta/'.length, -'.json'.length);
    const t = E.getToken.get(mint);
    if (!t) return json(res, 404, { error: 'unknown mint' });
    const o = originOf(req);
    // The image column holds a site-relative path like /img/ab12.png; an external fetcher needs it
    // absolute, and a data: URL would be refused by most of them.
    // ⛔ Never emit a data: URL here. Every external fetcher rejects one, and a JSON that "has an
    // image" nobody can load is worse than one that honestly has none — it looks fixed and is not.
    const img = !t.image || t.image.startsWith('data:') ? ''
      : /^https?:/i.test(t.image) ? t.image : o + t.image;
    const body = JSON.stringify({
      name: t.name || t.symbol, symbol: t.symbol, description: t.description || '',
      image: img,
      external_url: `${o}/t/${t.mint}`,
      extensions: { website: t.website || undefined, twitter: t.twitter || undefined, telegram: t.telegram || undefined },
      properties: img ? { files: [{ uri: img, type: 'image/png' }], category: 'image' } : undefined,
    });
    // ⛔ CORS and caching are not decoration here. A browser wallet fetches this from ITS OWN
    // origin, so without `access-control-allow-origin` the request fails and the coin shows no
    // image — the exact symptom this endpoint exists to cure. The default json() helper sends
    // `no-store` and no CORS, which is right for the rest of the API and wrong for this one file.
    res.writeHead(200, secure({
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    }, { frame: 'DENY' }));
    return res.end(body);
  }
  /**
   * The holder list for a coin, from wherever that coin's holders actually are.
   *
   * ⛔ E.holdersOf reads our own `holdings` table, which our own curve program writes — so for a
   * Meteora coin it returns NOTHING, and the Holders tab rendered its column headers above an empty
   * table while the coin had two dozen real holders. The count already came from chain, so the two
   * contradicted each other on the same page.
   */
  async function holdersFor(t, limit = 50) {
    if (t.venue !== 'dbc' || !CH.enabled()) return E.holdersOf(t.mint, limit).map((h) => ({ ...h, who: h.name || short(h.wallet) }));
    try {
      const IDX = await import('./lib/dbcindex.mjs');
      const MET = await import('./lib/meteora.mjs');
      // The pool's own vault is not a holder: it carries every token still unsold on the curve,
      // which on a young coin is most of the supply.
      const vaults = t.dbc_pool ? await MET.poolVaultsOf(CH.conn(), t.dbc_pool) : null;
      const rows = await IDX.holdersFromChain(CH.conn(), t.mint, { limit, exclude: [vaults?.base, vaults?.quote] });
      if (!rows) return [];
      return rows.map((h, i) => ({
        wallet: h.wallet, name: null, who: nameOf(h.wallet) || short(h.wallet),
        amount: h.amount, pct: h.amount / 1_000_000_000,
        heldSince: null, tier: null, share: 0, belowFloor: false, yieldEarned: 0,
        isDev: h.wallet === t.creator, rank: i + 1,
      }));
    } catch (e) { warn('dbc holders', e.message); return []; }
  }
  if (p === '/api/creator' && m === 'GET') {
    const who = new URL(req.url, 'http://x').searchParams.get('wallet');
    if (!isWallet(who)) return json(res, 400, { error: 'bad wallet' });
    const rows = E.coinsByCreator(who);
    const MET = rows.some((t) => t.venue === 'dbc') ? await import('./lib/meteora.mjs') : null;
    const coins = [];
    for (const t of rows.slice(0, 60)) {
      const q = Object.values(QUOTES).find((x) => x.symbol === t.quote);
      const dec = q?.decimals ?? 6, usd = usdOf(t.quote);
      // null means UNKNOWN — an RPC that did not answer must not be rendered as "nothing owed".
      let claimable = null;
      if (t.venue === 'dbc' && t.dbc_pool && MET && CH.enabled()) {
        // ⛔ THE PAGE MiKOL WAS LOOKING AT. It read 72.71 DOGE correctly that time; on a throttled
        // moment the same read returns null and the page tells a creator they are owed nothing,
        // which is the same complaint wearing different clothes.
        const f = await CH.readWithRetry(() => MET.creatorFeesOf(CH.conn(), t.dbc_pool));
        if (f) claimable = { quote: Number(f.quote) / 10 ** dec, base: Number(f.base) / 10 ** 6, rawQuote: String(f.quote), rawBase: String(f.base) };
      } else if (t.venue !== 'dbc') {
        claimable = { quote: t.creator_pot || 0, base: 0, rawQuote: String(Math.floor((t.creator_pot || 0) * 10 ** dec)), rawBase: '0' };
      }
      coins.push({
        mint: t.mint, name: t.name, symbol: t.symbol, image: t.image, quote: t.quote, quoteUsd: usd,
        venue: t.venue || 'rexpad', status: t.status, createdAt: t.created_at, pool: t.dbc_pool || null,
        holders: t.holders || 0, trades: t.trades || 0, volume: t.volume || 0,
        poolFeeBps: t.pool_fee_bps ?? null, creatorSharePct: t.creator_share_pct ?? null,
        website: t.website || null, twitter: t.twitter || null, telegram: t.telegram || null,
        claimable, claimedViaSite: t.creator_paid || 0,
      });
    }
    const sum = (f) => coins.reduce((a, c) => a + (f(c) || 0) * (c.quoteUsd || 0), 0);
    return json(res, 200, { wallet: who, coins,
      totals: {
        launches: rows.length,
        claimableUsd: sum((c) => c.claimable?.quote),
        claimedUsd: sum((c) => c.claimedViaSite),
        volumeUsd: sum((c) => c.volume),
        // A single unreadable pool makes the TOTAL a lower bound, and saying so is the
        // difference between an estimate and a wrong number.
        unknown: coins.some((c) => c.claimable === null),
      } });
  }
  // A coin's website and socials, changed by the wallet that launched it. Everything else about a
  // launch is fixed once it is signed; these three are not on chain and were the one thing a
  // creator could only ever set in the seconds before the mint existed.
  //
  // Worth knowing what else this moves: /api/meta/<mint>.json is read off the same `tokens` row,
  // and that URL is written into the immutable mint metadata — so a link added here reaches every
  // wallet and scanner that looks the coin up, not just this site.
  if (p === '/api/creator/links' && m === 'POST') { if (!need()) return;
    if (!throttle('links', wallet, 1000)) return json(res, 429, { error: 'Slow down' });
    try { return json(res, 200, { ok: true, links: E.setLinks(String(body.mint || ''), wallet, body) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/state') return json(res, 200, { quotes: quoteList(), stats: E.globalStats(), king: E.kingOfTheHill(), fairOpens: E.listTokens({ status: 'fairopen', sort: 'new', limit: 12 }), feed: E.recentTrades(30).map((t) => ({ ...t, who: nameOf(t.wallet) })), chain: CH.enabled() ? { programId: CH.programId().toBase58(), rpc: cfg.rpcUrl, cluster: /devnet/.test(cfg.rpcUrl) ? 'devnet' : /localhost|127\.0\.0\.1/.test(cfg.rpcUrl) ? 'local' : 'mainnet', faucet: !!cfg.faucetMint, faucetAmount: cfg.faucetAmount } : null,
    swap: JUP.enabled() ? { feeBps: JUP.feeBps(), network: 'mainnet' } : null,
    // ⛔ PUBLIC VALUES, AND NULL WHEN UNSET. A Privy app id identifies the app to Privy's API and is
    // meant to ship in the client — there is no secret here. Null is what makes the feature absent
    // rather than broken: the client never fetches the adapter and never draws a button for it.
    privyAppId: cfg.privyAppId || null, privyClientId: cfg.privyClientId || null,
    // Which venue new launches go to. Served rather than compiled in, so the switch to Meteora is a
    // deploy-time setting and can be turned off without shipping new client code.
    venue: cfg.launchVenue,
    // The second venue, and which pairs it can carry. ⛔ Curve configs are created by Raydium, not
    // by us, so this is NOT our quote table — but it is no longer a list typed in by hand either.
    // That list said three pairs while Raydium had configs for seven, which is why four of the
    // five META pairs were dead on the launch form with nothing offering them a venue.
    launchlab: await (async () => {
      try {
        const LL = await import('./lib/launchlab.mjs');
        LL.llRefreshConfigs().catch(() => {});   // off the request path; serves the cached set
        return { enabled: LL.llEnabled(), pairs: LL.llPairs() };
      } catch { return { enabled: false, pairs: [] }; }
    })(),
    // ⛔ WHETHER THE AI DIVIDEND CARD IS OFFERED AT ALL, decided by the SERVER. The mode needs a
    // model to do the picking, so a deployment with no AI_API_KEY has no feature — and a card that
    // promises "a model chooses your payout asset" on a box where nothing can choose is the exact
    // bug this replaced. `assets` is the live allowlist, derived from the quotes registry, so the
    // form can name the real assets instead of a list typed into the client that drifts from it.
    ai: { dividend: AI.dividendEnabled(), assets: AI.dividendAssets() },
    gate: { launchHoldUsd: cfg.launchHoldUsd, rexRateHoldUsd: cfg.rexRateHoldUsd, creatorRefBps: cfg.creatorRefBps, chatFloorUsd: cfg.chatFloorUsd, refHoldUsd: cfg.refHoldUsd, refVestVolumeUsd: cfg.refVestVolumeUsd, boostHoldUsd: cfg.boostHoldUsd, boostMult: cfg.boostMult, rexMint: QUOTES.REX.mint, rexCa: cfg.rexCa },
      // The fee module's own numbers, so the launch screen can never show a mix the contract rejects.
      fees: { stepBps: E.FEE_STEP_BPS, holderMinBps: E.HOLDER_MIN_BPS, holderMaxBps: E.HOLDER_MAX_BPS, sideMaxBps: E.SIDE_MAX_BPS, vaultMaxBps: E.VAULT_MAX_BPS, capBps: E.FEE_CAP_BPS,
              rexTiers: E.REX_TIERS, rexSlice: E.REX_SLICE, vaultSplit: E.VAULT_SPLIT, rewardFloorUsd: cfg.rewardFloorUsd },
      fairOpenChoices: E.FAIR_OPEN_CHOICES, fairOpenDefault: E.FAIR_OPEN_DEFAULT, me: wallet ? { wallet, name: nameOf(wallet), profile: profileOf(wallet), rexUsd: E.rexHeldUsd(wallet), canLaunch: E.canLaunch(wallet), rexRate: E.rexRateFor(wallet), balances: cfg.sim ? Object.fromEntries(db.prepare('SELECT asset, amount FROM balances WHERE wallet=?').all(wallet).map((r) => [r.asset, r.amount])) : {} } : null, sim: cfg.sim, online: clients.size });
  if (p === '/api/tokens' && m === 'GET') { const u = new URL(req.url, 'http://x'); return json(res, 200, { tokens: E.listTokens({ sort: u.searchParams.get('sort') || 'new', quote: u.searchParams.get('quote') || null, status: u.searchParams.get('status') || null, q: cleanText(u.searchParams.get('q'), 40) || null, limit: Math.max(1, Math.min(120, Math.floor(Number(u.searchParams.get('limit'))) || 60)) }) }); }
  // The pairs board. One endpoint, six sorts, four windows — see listPairs for why it is not six.
  if (p === '/api/pairs' && m === 'GET') {
    const u = new URL(req.url, 'http://x');
    return json(res, 200, E.listPairs({
      window: u.searchParams.get('window') || '24h',
      sort: u.searchParams.get('sort') || 'volume',
      q: cleanText(u.searchParams.get('q'), 40) || null,
      quote: u.searchParams.get('quote') || null,
      limit: Math.max(1, Math.min(200, Math.floor(Number(u.searchParams.get('limit'))) || 100)),
    }));
  }
  if (p === '/api/tokens' && m === 'POST') {
    if (!need()) return;
    // ⛔ THE VENUE IS ENFORCED HERE, NOT ONLY IN THE LAUNCH BUTTON. The client picks the path
    // from S.venue, so a browser that still has yesterday's bundle open sends the OLD-curve
    // launch even though this deployment is on Meteora — and that is not a cosmetic difference.
    // A coin on REX Chain's own bonding-curve program is invisible to DexScreener, Birdeye,
    // Jupiter and every trading bot, because none of them index a custom program. TEASURE
    // launched this way and could not be found in any scanner, which is exactly the problem
    // moving to Meteora was meant to end. A stale tab must not be able to mint an undiscoverable
    // coin, so the server refuses and says to reload.
    if (cfg.launchVenue === 'dbc') return json(res, 409, { error: 'This page is out of date — reload it. Launches now go to Meteora, where the coin is indexed by DexScreener, Jupiter and the bots from its first swap. A launch on the old curve would not be findable anywhere.', reload: true });
    if (!E.canLaunch(wallet)) return json(res, 403, { error: `Hold $${cfg.launchHoldUsd} of $REX to launch — you hold $${E.rexHeldUsd(wallet).toFixed(2)}. It stays in your wallet; nothing is spent.`, needRexUsd: cfg.launchHoldUsd, haveRexUsd: E.rexHeldUsd(wallet) });
    let image = null; try { image = saveImage(body.image); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!image) return json(res, 400, { error: 'An image is required' });
    // ⛔ THE RATE LIMIT IS SPENT HERE, AFTER EVERY CHECK THAT CAN REJECT — never before them.
    // Taken at the top it was consumed by a stale-venue 409, a failed $REX gate, a missing image
    // or a bad field, so somebody who had launched nothing at all was told "one launch per
    // minute" and locked out for 60s. That is exactly what was reported today on the other launch
    // path; this one still had it. A limit should count launches, not failed form posts.
    if (!throttle('launch', wallet, 60_000)) return json(res, 429, { error: 'One launch per minute per wallet' });
    try {
      const t = E.createToken(wallet, { name: body.name, symbol: body.symbol, description: cleanText(body.description, 600), image, website: cleanUrl(body.website), twitter: cleanUrl(body.twitter), telegram: cleanUrl(body.telegram), quote: body.quote, holderBps: body.holderBps ?? body.taxBps, creatorBps: body.creatorBps, vaultBps: body.vaultBps, burnBps: body.burnBps, buybackBps: body.buybackBps, refShareBps: body.refShareBps,
        allowlist: cleanText(body.allowlist, 4000), allowRexUsd: body.allowRexUsd, walletCap: body.walletCap, decayFeeBps: body.decayFeeBps, decayTo: body.decayTo,
        fairOpenSecs: body.fairOpenSecs, devBuy: body.devBuy, rewardMode: body.rewardMode });
      return json(res, 200, { token: E.publicToken(t) });
    } catch (e) { if (image) { try { fs.unlinkSync(path.join(IMG, path.basename(image))); } catch {} } return json(res, 400, { error: e.message }); }
  }
  let mm = /^\/api\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})(\/[a-z]+)?$/.exec(p);
  if (mm && m === 'GET') {
    const t = E.getToken.get(mm[1]); if (!t) return json(res, 404, { error: 'not found' });
    const u = new URL(req.url, 'http://x');
    if (mm[2] === '/candles') return json(res, 200, { candles: E.candles(t.mint, u.searchParams.get('tf') || '1m', 400) });
    if (mm[2] === '/trades') return json(res, 200, { trades: E.tradesOf(t.mint, 80).map((x) => ({ ...x, who: nameOf(x.wallet) })) });
    if (mm[2] === '/holders') return json(res, 200, { holders: await holdersFor(t, 100) });
    if (mm[2] === '/chat') return json(res, 200, { chat: db.prepare('SELECT * FROM chat WHERE mint=? ORDER BY ts DESC LIMIT 60').all(t.mint).reverse() });
    if (mm[2] === '/payouts') return json(res, 200, { epochs: db.prepare('SELECT * FROM epochs WHERE mint=? ORDER BY ts DESC LIMIT 20').all(t.mint), recent: db.prepare('SELECT * FROM payouts WHERE mint=? ORDER BY ts DESC LIMIT 30').all(t.mint).map((x) => ({ ...x, who: nameOf(x.wallet) })) });
    return json(res, 200, { token: E.publicToken(t, { reward: true }), creatorName: nameOf(t.creator), trades: E.tradesOf(t.mint, 40).map((x) => ({ ...x, who: nameOf(x.wallet) })), holders: await holdersFor(t, 30), chat: db.prepare('SELECT * FROM chat WHERE mint=? ORDER BY ts DESC LIMIT 60').all(t.mint).reverse(), me: await meOn(wallet, t.mint), posts: E.postsOf(t.mint).map((x) => ({ ...x, who: nameOf(x.wallet) })),
      ref: wallet ? E.refStatsFor(wallet, t.mint) : null,
      milestones: E.milestonesOf(t.mint), creatorHistory: E.creatorHistory(t.creator),
      chatGate: wallet ? E.canChat(wallet, t.mint) : { ok: false, reason: 'Connect a wallet to post' },
      nextEpochAt: E.nextEpochAt(), ladder: E.LADDER, convictionScale: cfg.convictionScale });
  }
  if (p === '/api/quote' && m === 'POST') {
    const t = E.getToken.get(String(body.mint || '')); if (!t) return json(res, 404, { error: 'not found' });
    try { const amt = Number(body.amount); if (!Number.isFinite(amt) || amt <= 0) return json(res, 400, { error: 'Amount must be a positive number' }); let q; if (body.side === 'sell') { const have = wallet ? E.holdingOf(wallet, t.mint).amount : Infinity; q = E.previewSell(t, Math.min(amt, have)); q.clamped = amt > have; } else q = E.previewBuy(t, amt); return json(res, 200, { quote: q }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/trade' && m === 'POST') {
    if (!need()) return;
    if (!throttle('trade', wallet, 250)) return json(res, 429, { error: 'Slow down' });
    const mint = String(body.mint || ''); const amt = Number(body.amount); if (!Number.isFinite(amt) || amt <= 0) return json(res, 400, { error: 'Amount must be a positive number' }); const slip = Math.max(0, Math.min(5000, Number(body.slippageBps) || 100));
    try {
      const t = E.getToken.get(mint); if (!t) return json(res, 404, { error: 'not found' });
      let r;
      if (body.side === 'sell') { const q = E.previewSell(t, Math.min(amt, E.holdingOf(wallet, mint).amount)); r = E.sell(wallet, mint, amt, q.quoteOut * (1 - slip / 10_000)); }
      else { const q = E.previewBuy(t, amt); r = E.buy(wallet, mint, amt, q.tokensOut * (1 - slip / 10_000)); }
      drainEvents();
      return json(res, 200, { result: { ...r, trade: undefined }, trade: r.trade, me: await meOn(wallet, mint), token: E.publicToken(E.getToken.get(mint)) });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/fairopen/bid' && m === 'POST') { if (!need()) return; if (!throttle('bid', wallet, 250)) return json(res, 429, { error: 'Slow down' }); try { const amt = Number(body.amount); if (!Number.isFinite(amt) || amt <= 0) return json(res, 400, { error: 'Amount must be a positive number' }); const r = E.placeBid(wallet, String(body.mint || ''), amt); drainEvents(); return json(res, 200, { ...r, me: await meOn(wallet, String(body.mint)) }); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p === '/api/fairopen/cancel' && m === 'POST') { if (!need()) return; try { const r = E.cancelBid(wallet, String(body.mint || '')); drainEvents(); return json(res, 200, { ...r, me: await meOn(wallet, String(body.mint)) }); } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p === '/api/chat' && m === 'POST') {
    if (!need()) return; const mint = String(body.mint || ''); const text = cleanText(body.text, 280); if (!E.getToken.get(mint) || !text) return json(res, 400, { error: 'empty' });
    const gate = E.canChat(wallet, mint); if (!gate.ok) return json(res, 403, { error: gate.reason, floorUsd: gate.floorUsd });
    const last = db.prepare('SELECT ts FROM chat WHERE wallet=? ORDER BY ts DESC LIMIT 1').get(wallet)?.ts || 0; if (Date.now() - last < 1500) return json(res, 429, { error: 'slow down' });
    const row = { mint, wallet, name: nameOf(wallet), text, ts: Date.now() };
    db.prepare('INSERT INTO chat(mint,wallet,name,text,ts) VALUES(?,?,?,?,?)').run(mint, wallet, row.name, text, row.ts);
    broadcast({ type: 'chat', ...row }, mint); return json(res, 200, { ok: true });
  }
  // Spreads the profile for the same reason /api/profile/:wallet does: the page that renders YOUR
  // profile and the page that renders someone else's are one function, so they have to be fed the
  // same shape or your own bio is the only one that never appears.
  if (p === '/api/me' && m === 'GET') { if (!need()) return;
    // ⛔ THE PORTFOLIO IS THE ONE PLACE A WRONG NUMBER IS UNFORGIVABLE, so the mirror is checked
    // against the chain before it is shown. Bounded: a slow or dead RPC must not hold the page
    // hostage, so after two and a half seconds we serve what we have and let the sweep finish in
    // the background — the next open gets the corrected figures.
    if (RECON.dueFor(wallet)) {
      const sweep = RECON.reconcileWallet(wallet).catch((e) => warn('reconcile', e.message));
      await Promise.race([sweep, new Promise((r) => setTimeout(r, 2500))]);
    }
    return json(res, 200, { ...E.portfolio(wallet), ...profileOf(wallet),
      // Where the tokens actually are. The team asked how to "transfer these out" — for an on-chain
      // coin there is nothing to transfer, and saying so in the payload is how the page can say so.
      custody: CH.enabled() ? 'wallet' : 'paper',
      points: PTS.pointsOf(wallet), record: PTS.holdRecord(wallet), rank: PTS.rankOf(wallet).rank, mine: true }); }
  if (p === '/api/me/name' && m === 'POST') { if (!need()) return; const name = cleanHandle(body.name);
    if (name && (HANDLE_RESERVED.test(name) || handleTaken(name, wallet))) return json(res, 400, { error: 'That name is taken or reserved' });
    db.prepare('UPDATE wallets SET name=? WHERE wallet=?').run(name || null, wallet); return json(res, 200, { name: nameOf(wallet) }); }

  // ---------- profiles: a wallet is an address, and nobody recognises an address
  // `named` is what the welcome screen keys off — a wallet that has never picked a handle gets the
  // one-time setup, and everyone else does not see it again.
  if (p === '/api/me/profile' && m === 'GET') { if (!need()) return;
    return json(res, 200, { profile: profileOf(wallet), nftAvatars: NFT.enabled() }); }

  if (p === '/api/me/profile' && m === 'POST') { if (!need()) return;
    // Loose enough that setting a name and then a picture is not a fight, tight enough that the
    // handle table cannot be probed for who holds what.
    if (!throttle('profile', wallet, 2_000)) return json(res, 429, { error: 'Slow down' });
    const cur = profileOf(wallet);
    // Every field is optional on an update: only what was sent changes, so the welcome screen and a
    // later single-field edit can both post here without one wiping what the other set.
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    let name = cur.named ? cur.name : null;
    if (has('name')) {
      name = cleanHandle(body.name);
      if (name && HANDLE_RESERVED.test(name)) return json(res, 400, { error: 'That name is reserved' });
      if (name && handleTaken(name, wallet)) return json(res, 400, { error: 'That name is taken' });
    }
    let avatar = cur.avatar;
    if (has('avatarNft')) {
      // An NFT picture is only accepted after we have CHECKED the wallet holds it and that it is a
      // verified member of the collection. Taking the client's word would let anyone wear the badge.
      const want = String(body.avatarNft || '');
      if (!want) avatar = null;
      else {
        const owned = await NFT.rexProfileOptions(wallet);
        const pick = owned.find((n) => n.mint === want);
        if (!pick) return json(res, 400, { error: 'That NFT is not in this wallet, or is not a verified REX NFT' });
        avatar = pick.image;
      }
    } else if (has('avatar')) {
      try { avatar = saveImage(body.avatar) ?? (body.avatar ? cur.avatar : null); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    db.prepare(`UPDATE wallets SET name=?, bio=?, avatar=?, x=?, telegram=?, website=?, profile_at=COALESCE(profile_at,?) WHERE wallet=?`)
      .run(name || null, has('bio') ? cleanText(body.bio, 160) : cur.bio, avatar,
        has('x') ? cleanHandleField(body.x) : cur.x, has('telegram') ? cleanHandleField(body.telegram) : cur.telegram,
        has('website') ? cleanUrl(body.website) : cur.website, Date.now(), wallet);
    return json(res, 200, { profile: profileOf(wallet) }); }

  // The REX NFTs this wallet actually holds, with their artwork — what the welcome screen offers as
  // a profile picture. Never fails the caller: no collection configured, or an RPC that will not
  // answer, both come back as an empty list.
  if (p === '/api/me/nfts' && m === 'GET') { if (!need()) return;
    if (!NFT.enabled()) return json(res, 200, { nfts: [], enabled: false });
    return json(res, 200, { nfts: await NFT.rexProfileOptions(wallet), enabled: true }); }
  if (p === '/api/faucet' && m === 'POST') { if (!need()) return; if (!cfg.sim) return json(res, 403, { error: 'The paper faucet only exists on the demo market.' }); for (const [a, n] of Object.entries(E.faucetAmounts())) if (E.balanceOf(wallet, a) < n * 0.2) E.credit(wallet, a, n); return json(res, 200, { balances: cfg.sim ? Object.fromEntries(db.prepare('SELECT asset, amount FROM balances WHERE wallet=?').all(wallet).map((r) => [r.asset, r.amount])) : {} }); }
  mm = /^\/api\/profile\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  // A wallet's PUBLIC record: identity, points, how long it has held, badges. No session needed and
  // none implied — looking someone up is not an account action, and requiring a connection to read
  // a public board would be security theatre that costs the cautious the most.
  if (mm && m === 'GET') {
    const w = mm[1];
    const pf = E.portfolio(w);
    return json(res, 200, {
      ...pf, ...profileOf(w), balances: undefined, bids: undefined,
      points: PTS.pointsOf(w), record: PTS.holdRecord(w), rank: PTS.rankOf(w).rank,
      // Whether the VIEWER is this wallet — what decides between "claim this" and "edit".
      mine: !!wallet && wallet === w,
    });
  }
  // ---------- on-chain: the server builds, the wallet signs, the browser broadcasts
  // ---------- Jupiter: swap any Solana token, with REX's own fee on the route
  if (p.startsWith('/api/jup/')) {
    if (!JUP.enabled()) return json(res, 503, { error: 'swaps are off (set JUP_RPC)' });
    const sub = p.slice('/api/jup/'.length);
    try {
      if (sub === 'tokens' && m === 'GET') return json(res, 200, { tokens: await JUP.tokens(), feeBps: JUP.feeBps() });
      if (m !== 'POST') return json(res, 405, { error: 'POST required' });
      if (sub === 'token') return json(res, 200, { token: await JUP.tokenInfo(String(body.mint || '')) });
      // Whether the wallet can pay a network fee at all, asked BEFORE the button is armed. A wallet
      // with no SOL cannot swap its way to SOL, and the failure it gets instead is unreadable.
      if (sub === 'ready') return json(res, 200, await JUP.readiness(String(body.wallet || '')));
      if (sub === 'quote') {
        // Validate BEFORE throttling. The throttle exists to protect the round trip to Jupiter, and a
        // request that is malformed never makes one — answering it with "slow down" would be telling
        // the caller the wrong thing about their own bug.
        JUP.validate(body);
        // One quote per 250ms per caller — a quote is a round trip, not a local sum.
        if (!throttle('jupq', String(body.userPublicKey || req.socket.remoteAddress || 'anon'), 250)) return json(res, 429, { error: 'Slow down' });
        return json(res, 200, await JUP.quote(body));
      }
      if (sub === 'swap') return json(res, 200, await JUP.build({ quoteResponse: body.quoteResponse, userPublicKey: String(body.userPublicKey || '') }));
      if (sub === 'send') return json(res, 200, { signature: await JUP.send(body.tx) });
      return json(res, 404, { error: 'not found' });
    } catch (e) { warn('jup', sub, e.message); return json(res, 400, { error: e.message }); }
  }

  if (p.startsWith('/api/chain/')) {
    if (!CH.enabled()) return json(res, 503, { error: 'on-chain mode is off (set RPC_URL and deploy the program)' });
    const sub = p.slice('/api/chain/'.length);
    try {
      if (sub === 'claimable' && m === 'GET') { const w2 = new URL(req.url, 'http://x').searchParams.get('wallet'); if (!isWallet(w2)) return json(res, 400, { error: 'bad wallet' }); return json(res, 200, { claims: IX.claimable(w2) }); }
      // Real, on-chain balance of one mint for one wallet. The launch form needs this because
      // `S.me.balances` is SIM-only paper money and is empty on mainnet, so the dev buy field had
      // no way to tell the launcher what they could actually spend.
      if (sub === 'held' && m === 'GET') {
        const u2 = new URL(req.url, 'http://x'); const mint = u2.searchParams.get('mint'), who = u2.searchParams.get('wallet');
        if (!isWallet(mint) || !isWallet(who)) return json(res, 400, { error: 'bad mint or wallet' });
        const held = await CH.heldOf(who, mint);
        return json(res, 200, held
          ? { spendable: String(held.spendable), total: String(held.total), decimals: held.decimals }
          : { unknown: true });
      }
      if (sub === 'status' && m === 'GET') return json(res, 200, { programId: CH.programId().toBase58(), config: await CH.configAccount(), launches: (await CH.launches()).length });
      if (sub === 'launches' && m === 'GET') return json(res, 200, { launches: await CH.launches() });
      if (sub === 'launch' && m === 'GET') { const mint = new URL(req.url, 'http://x').searchParams.get('mint'); if (!isWallet(mint)) return json(res, 400, { error: 'bad mint' });
        const [l, positions, epochs] = await Promise.all([CH.launchOf(mint), CH.positionsOf(mint), CH.epochsOf(mint)]);
        return json(res, 200, { launch: l, positions: positions.length, epochs }); }
      if (sub === 'me' && m === 'GET') { const u = new URL(req.url, 'http://x'); const mint = u.searchParams.get('mint'), w = u.searchParams.get('wallet');
        if (!isWallet(mint) || !isWallet(w)) return json(res, 400, { error: 'bad mint or wallet' });
        const [pos, com] = await Promise.all([CH.positionOf(mint, w), CH.commitOf(mint, w)]);
        return json(res, 200, { position: pos, commitment: com }); }

      if (m !== 'POST') return json(res, 405, { error: 'POST required' });
      const w = String(body.wallet || '');
      if (sub !== 'send' && !isWallet(w)) return json(res, 400, { error: 'bad wallet' });
      const amt = (v) => { const x = Math.floor(Number(v)); if (!Number.isFinite(x) || x <= 0) throw new Error('Amount must be a positive integer of base units'); return x; };

      if (sub === 'build/create') { if (throttled('build', w, req, 5_000, 2_000)) return json(res, 429, { error: 'One moment — still preparing your last attempt' });
        // ⛔ THE VENUE IS ENFORCED HERE, NOT ONLY IN THE LAUNCH BUTTON. The client picks the path
        // from S.venue, so a browser that still has yesterday's bundle open sends the OLD-curve
        // launch even though this deployment is on Meteora — and that is not a cosmetic difference.
        // A coin on REX Chain's own bonding-curve program is invisible to DexScreener, Birdeye,
        // Jupiter and every trading bot, because none of them index a custom program. TEASURE
        // launched this way and could not be found in any scanner, which is exactly the problem
        // moving to Meteora was meant to end. A stale tab must not be able to mint an undiscoverable
        // coin, so the server refuses and says to reload.
        if (cfg.launchVenue === 'dbc') return json(res, 409, { error: 'This page is out of date — reload it. Launches now go to Meteora, where the coin is indexed by DexScreener, Jupiter and the bots from its first swap. A launch on the old curve would not be findable anywhere.', reload: true });
        return json(res, 200, await CH.buildCreateLaunch({ creator: w, quoteMint: String(body.quoteMint || ''), raiseTarget: amt(body.raiseTarget), vQuote0: amt(body.vQuote0),
          // Validated here as well as in the program, so a hand-rolled request gets the same answer the UI gives.
          ...E.validateFees({ holderBps: body.holderBps ?? body.taxBps, creatorBps: body.creatorBps, vaultBps: body.vaultBps, burnBps: body.burnBps, buybackBps: body.buybackBps }),
          fairOpenSecs: Math.max(0, Math.min(3600, Math.floor(Number(body.fairOpenSecs) || 0))) })); }
      if (sub === 'build/commit') { if (throttled('bid', w, req, 250, 120)) return json(res, 429, { error: 'Slow down' });
        return json(res, 200, await CH.buildCommit({ bidder: w, mint: String(body.mint || ''), amount: amt(body.amount) })); }
      if (sub === 'build/withdraw') return json(res, 200, await CH.buildWithdrawCommit({ bidder: w, mint: String(body.mint || '') }));
      if (sub === 'build/claim-fairopen') return json(res, 200, await CH.buildClaimFairOpen({ bidder: w, mint: String(body.mint || '') }));
      if (sub === 'build/buy') { if (throttled('trade', w, req, 250, 120)) return json(res, 429, { error: 'Slow down' });
        return json(res, 200, await CH.buildBuy({ user: w, mint: String(body.mint || ''), quoteIn: amt(body.quoteIn), minTokensOut: Math.max(0, Math.floor(Number(body.minTokensOut) || 0)) })); }
      if (sub === 'build/sell') { if (throttled('trade', w, req, 250, 120)) return json(res, 429, { error: 'Slow down' });
        return json(res, 200, await CH.buildSell({ user: w, mint: String(body.mint || ''), tokensIn: amt(body.tokensIn), minQuoteOut: Math.max(0, Math.floor(Number(body.minQuoteOut) || 0)) })); }
      if (sub === 'build/claim-reward') return json(res, 200, await CH.buildClaimReward({ claimant: w, mint: String(body.mint || ''), index: Math.floor(Number(body.index) || 0), amount: amt(body.amount), proof: Array.isArray(body.proof) ? body.proof.slice(0, 32).map(String) : [] }));
      // ---- Meteora DBC. The venue new launches go to: indexed by DexScreener and Jupiter from the
      // first trade, and the pool fee stays claimable after graduation instead of being burned with
      // the LP. Returns unsigned transactions — the user's wallet signs, never the server.
      if (sub === 'dbc/build') {
        // ⛔ BUILDING IS NOT LAUNCHING. This used the 60-second launch lock, so cancelling the
        // wallet prompt — or any failure after the build — left the launcher locked out for a full
        // minute, told "one launch per minute" when they had never launched anything. The long lock
        // belongs on the step that actually creates a coin; a build only needs enough of a guard to
        // stop someone hammering it.
        if (throttled('build', w, req, 5_000, 2_000)) return json(res, 429, { error: 'One moment — still preparing your last attempt' });
        const MET = await import('./lib/meteora.mjs');
        const name = cleanText(body.name, 32);
        const symbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        if (name.length < 2 || symbol.length < 2) return json(res, 400, { error: 'Name and ticker are too short' });
        const quoteMint = String(body.quoteMint || '');
        if (!isWallet(quoteMint)) return json(res, 400, { error: 'bad quote mint' });
        // ⛔ Enforce the SAME block the launch form shows. The form greys out an unavailable pair,
        // but a greyed-out button is not a rule — anyone calling this route directly could still
        // launch a coin quoted in an asset with no trading route, and nobody could ever buy or sell
        // it. The UI state and the server's answer have to agree, and the server's is the one that
        // counts.
        //
        // ⛔ AND ASK IT OF THE VENUE BEING LAUNCHED ON. `quoteBlock` collapses two different
        // refusals into one string, and this guard used the collapsed answer: a pair Meteora will
        // not take was refused here, 120 lines before the branch below could send it to LaunchLab
        // — which takes it. The form knew better and said "via LaunchLab" on the chip, so the five
        // fee-bearing pairs were offered, posted with `venue: 'launchlab'`, and then refused by a
        // sentence that itself read "It launches on Raydium LaunchLab instead". Julz met all of
        // that on 24 Oct. `venueBlock` keeps the cluster block absolute and scopes the badge block
        // to the venue it actually describes.
        const q = Object.values(QUOTES).find((x) => x.mint === quoteMint);
        const venueWanted = String(body.venue || '') === 'launchlab' ? 'launchlab' : 'dbc';
        const block = q && venueBlock(q.symbol, venueWanted);
        if (block) return json(res, 400, { error: `${q.symbol} cannot be used as a pair: ${block}` });
        // ⛔ REFUSE AN UNAFFORDABLE LAUNCH IN WORDS, BEFORE THE WALLET PROMPT.
        //
        // A launch pays rent for the mint, its metadata account and the pool's accounts — measured
        // on the two most recent mainnet launches: $BITE 0.0221 SOL and $ZECRET 0.0266 SOL. Short of
        // it, the transaction simulates and fails deep inside Metaplex, and what the launcher sees
        // is a wall of program logs ending in "Transfer: insufficient lamports 10105006, need
        // 13733800". MiKOL hit exactly that, had no idea it meant "add 0.004 SOL", and asked the
        // team how much a launch costs — which is the question this should have answered up front.
        //
        // The same reasoning as the dev-buy guard below: say which asset, say how much they have,
        // say how much is needed. Rent is NOT a fee REX Chain takes — it is Solana's, and it is why
        // this cannot be waived.
        try {
          const lamports = await CH.conn().getBalance(new PublicKey(w));
          // ⛔ A SOL-QUOTED LAUNCH SPENDS THE RENT *AND* THE OPENING BUY, out of the same balance.
          // Checking the floor alone passes a wallet that then has nothing left to buy with, and
          // the failure lands after the wallet prompt instead of before it.
          const openingSol = String(body.quoteMint || '') === 'So11111111111111111111111111111111111111112'
            ? Math.max(0, Number(body.devBuy) || 0) / 1e9 : 0;
          const needSol = LAUNCH_SOL_FLOOR + openingSol;
          if (lamports < needSol * 1e9) {
            // ⛔ NAME THE WALLET. "Your wallet has no SOL" to someone who is certain they have SOL is
            // a dead end — and they are usually both right, because Phantom was on a DIFFERENT
            // ACCOUNT from the one the site is signed in as. Edipo hit exactly this and the team
            // spent the evening on it. Printing the address the balance was read from turns an
            // argument into a glance, and saying how much MORE is needed beats restating the floor.
            const haveSol = lamports / 1e9;
            return json(res, 400, { error:
              `${short(w)} holds ${haveSol.toFixed(4)} SOL — this launch needs about ${needSol.toFixed(3)}`
              + `${openingSol > 0 ? ` (${LAUNCH_SOL_FLOOR} rent + ${openingSol.toFixed(4)} opening buy)` : ''}, `
              + `so add ${(needSol - haveSol).toFixed(3)} more. The rent pays Solana for the mint, its metadata and `
              + `the pool accounts: network rent, not a REX Chain fee, so it cannot be waived. `
              + `If you expected more here, check your wallet is on that account — the site signs with the one you connected.` });
          }
        } catch (e) { warn('launch sol check', e.message); }   // never block a launch on an RPC hiccup
        const devBuy = BigInt(Math.max(0, Math.floor(Number(body.devBuy) || 0)));
        // ⛔ A DEV BUY SPENDS THE QUOTE ASSET, AND NOTHING CHECKED THE LAUNCHER HELD ANY.
        // The form's dev buy box is denominated in the PAIR, not in SOL, and on mainnet the client
        // has no balance data at all (paper balances are SIM-only), so it cannot warn. Without this
        // guard the only feedback was a wallet prompt followed by `TransferChecked / insufficient
        // funds / 0x1` from inside the Meteora program — which reads as "the launchpad is broken",
        // not as "you own none of the token you chose to pay with". Refuse here, in words, BEFORE
        // asking anybody to sign. Checked server-side because the client's copy is a courtesy.
        if (devBuy > 0n) {
          const sym = q?.symbol || 'the pair asset', dec = q?.decimals ?? 6;
          const human = (raw) => (Number(raw) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: dec });
          const held = await CH.heldOf(w, quoteMint);
          // A failed read is UNKNOWN, not zero — refusing a legitimate launch because an RPC
          // blinked would be its own bug. Let it through and let simulation be the backstop.
          if (held && held.spendable < devBuy) {
            const short = devBuy - held.spendable;
            if (held.total > held.spendable) {
              return json(res, 400, { error: `Your dev buy needs ${human(devBuy)} ${sym}, and your main ${sym} account holds ${human(held.spendable)}. You do hold ${human(held.total)} ${sym} in total, but it sits in a second account the pool cannot draw on — send it to your main ${sym} account first, or set the dev buy to 0.` });
            }
            return json(res, 400, { error: held.spendable === 0n
              // ⛔ "paid in SOL — not SOL" is what this said on a SOL-quoted launch. The clause exists
              // to stop someone typing a SOL figure against a token pair; when the pair IS SOL it
              // contradicts itself and reads as a broken product. Julz screenshotted exactly that.
              ? `You hold no ${sym}, and the opening buy is paid in ${sym}${sym === 'SOL' ? '' : ' — not SOL'}. Set it to 0 to launch now, or buy at least ${human(devBuy)} ${sym} first.`
              : `Your dev buy needs ${human(devBuy)} ${sym} but you hold ${human(held.spendable)} — ${human(short)} short. Lower it, or set it to 0 to launch without one.` });
          }
        }
        // ⛔ THE CURVE IS SIZED IN THE QUOTE ASSET, NOT IN DOLLARS.
        //
        // `buildCurveWithMarketCap` takes both market caps denominated in the quote token, and the
        // form sends what a human means — "open around $5K, graduate at $50K". Passing those
        // straight through makes the number mean whatever the quote asset happens to be worth:
        //
        //   quote REX (~$0.00011)  →  "50,000" = $5.60   — the entire curve graduates on a $6 buy
        //   quote SOL (~$122)      →  "50,000" = $6.1M   — nobody ever graduates it
        //
        // $REXWEEN, the first real Meteora launch, shipped with a curve worth about five dollars
        // end to end; the SDK answered a $56 buy with "Insufficient Liquidity", which reads as a
        // broken pool rather than a pool the size of a sandwich. Convert, every time.
        const qUsd = usdOf(q?.symbol || '');
        // No price means no safe conversion. Refusing is the only honest option: a fallback is
        // exactly what sized REXWEEN, and a mis-sized curve cannot be fixed after it is created.
        if (!(qUsd > 0)) return json(res, 503, { error: `No price for ${q?.symbol || 'the pair asset'} right now, so the curve cannot be sized safely. Try again in a minute, or pick another pair.` });
        const capUsd = Math.max(100, Number(body.initialMarketCap) || 5_000);
        const migUsd = Math.max(1_000, Number(body.migrationMarketCap) || 50_000);
        // ⛔ THE TWO TARGETS HAVE TO MAKE A CURVE, AND THE SDK SAYS SO IN ARITHMETIC.
        // A migration target at or below the opening one is not a shallow curve, it is no curve:
        // the maths underflows and the launcher is shown "SafeMath: subtraction overflow". The form
        // never sends such a pair, but the route accepts whatever arrives, and a number that
        // decides what a coin is worth should not be taken on trust from the caller.
        if (!(migUsd > capUsd * 1.5)) {
          return json(res, 400, { error: 'The graduation target has to be meaningfully above the opening one — a curve needs room to rise.' });
        }
        if (capUsd > 10_000_000) {
          return json(res, 400, { error: 'That opening market cap is too large for a launch curve. Pick something under $10m.' });
        }
        if (migUsd <= capUsd) return json(res, 400, { error: 'The graduation market cap has to be above the opening one' });
        // ⛔ RESOLVE THE HOOK BEFORE ANYTHING IS BUILT, AND REFUSE IN WORDS.
        //
        // A transfer hook gives a third-party program a veto over every transfer of the coin, for
        // ever — the mint is immutable, so it can never be removed. Naming one that is not an
        // executable program produces, at best, a launch that fails after the user has signed and
        // paid, and at worst a coin whose every transfer reverts. Hooked's own catalogue publishes
        // at least one rule — "Anti-bundle" — whose program has no account on mainnet at all, which
        // is exactly how a launcher would find out the hard way.
        // ⛔ THE CURVE'S SIZE DEPENDS ON THIS NUMBER, SO IT COMES FROM THE CHAIN — NOT FROM THE
        // BROWSER, AND NOT FROM OUR OWN TABLE.
        //
        // It used to be `Number(body.quoteDecimals) || 6`: the client read it out of the quote
        // table in prices.mjs and the server believed whatever arrived. Both halves were wrong.
        // The table had STONK and ZCAT at 6 when the chain says 9, so a STONK-paired launch sized
        // its curve a THOUSAND times too small and opened at a $5 market cap — which is the "it
        // created pair with a $5 market cap" Julz reported, and the "why does this keep happening"
        // after it. And a number that decides how much a coin is worth must never be supplied by
        // the caller: a crafted request could mis-size any curve on purpose.
        //
        // A failed read REFUSES. Falling back to 6 is precisely the guess that caused this, and a
        // launch that waits a minute is cheaper than a curve that is wrong for ever.
        const LPD = await import('./lib/lp.mjs');
        const quoteDecimals = await LPD.decimalsOf(CH.conn(), quoteMint);
        if (!Number.isInteger(quoteDecimals)) {
          return json(res, 503, { error: 'Could not read the pair token\u2019s decimals from the chain just now — try again in a moment. Launching on a guess would size the curve wrongly.' });
        }
        // ---------------------------------------------------------------- the second venue
        //
        // ⛔ IT BRANCHES *HERE*, AFTER EVERY GUARD ABOVE, ON PURPOSE. Name and ticker, the pair
        // block, the SOL floor, the dev-buy balance check, the decimals read off the chain and the
        // curve sized in quote units rather than dollars — every one of those was written because
        // it had already gone wrong once. A second route would start without them and acquire them
        // again one incident at a time. One route, two builders.
        if (String(body.venue || '') === 'launchlab') {
          const LL = await import('./lib/launchlab.mjs');
          const { Keypair, Transaction, PublicKey } = await import('@solana/web3.js');
          if (!LL.llEnabled()) return json(res, 400, { error: 'The LaunchLab venue is not switched on yet.' });
          const Q = LL.llQuoteOf(quoteMint);
          if (!Q) {
            return json(res, 400, { error: `LaunchLab has no curve for ${q?.symbol || 'that pair'}. Raydium creates those, `
              + `not us, so this venue can only pair with ${LL.llPairs().join(', ')}.` });
          }
          // ⛔ A transfer-hook rule is a Meteora-path feature: this venue's initialize sets a
          // transfer FEE, not a hook, so a rule chosen here would be silently dropped — which is
          // how $B24837 and $KT ended up with a rule named and never switched on.
          if (body.hook) return json(res, 400, { error: 'Transfer rules are only available on the Meteora venue. Launch without a rule, or pick a pair Meteora accepts.' });
          let curve;
          try { curve = LL.llCurveFor(capUsd / qUsd, Q); }
          catch (e) { return json(res, 400, { error: e.message }); }
          const mintKp = Keypair.generate();
          const mint = mintKp.publicKey.toBase58();
          const uri = cleanUrl(body.uri) || `${originOf(req)}/api/meta/${mint}.json`;
          let init;
          try { init = await LL.llInitIx({ owner: w, mint, Q, name, symbol, uri, taxBps: 0, raiseRaw: curve.raiseRaw }); }
          catch (e) { return json(res, 400, { error: `This curve cannot be created: ${e.message}` }); }
          const tx = new Transaction().add(init.ix);
          // The opening buy rides inside the same transaction, so nothing can buy ahead of it.
          if (devBuy > 0n) {
            try {
              const buy = await LL.llBuy({ owner: w, mint, Q, creator: w,
                amountIn: Number(devBuy) / 10 ** Q.dec, slippageBps: 500,
                fresh: { raiseRaw: curve.raiseRaw, taxBps: 0 } });
              for (const ix of buy.ixs) tx.add(ix);
            } catch (e) { return json(res, 400, { error: `The opening buy does not fit this curve: ${e.message}` }); }
          }
          tx.feePayer = new PublicKey(w);
          tx.recentBlockhash = (await CH.conn().getLatestBlockhash('confirmed')).blockhash;
          return json(res, 200, {
            venue: 'launchlab', mint, pool: init.pool, config: Q.config, quote: Q.symbol,
            devBuyAfter: '0', rule: null,
            raise: curve.raise, startMcapQuote: curve.startMcapQuote, endMcapQuote: curve.endMcapQuote,
            steps: [{
              label: 'launch',
              tx: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
              signers: [Buffer.from(mintKp.secretKey).toString('base64')],
            }],
          });
        }

        // ⛔ A RULE IS ONLY OFFERED IF WE CAN SWITCH IT ON. `resolveRule` validates the key, checks
        // the program is executable and cleans the parameters; the launch then carries the rule's
        // own `initialize` as a step the launcher signs. Before this, a rule was NAMED on the mint
        // and never configured, which does not make a rule that does nothing — it makes a coin
        // whose every transfer reverts. Two of those are on mainnet.
        const HOOK = await import('./lib/hooked.mjs');
        let chosen = null;
        try { chosen = await HOOK.resolveRule(body.hook, body.hookParams || {}); }
        catch (e) { return json(res, 400, { error: e.message }); }
        const hook = chosen ? { program: chosen.rule.program.toBase58(), rule: chosen.rule } : null;
        const r = await MET.buildLaunch({
          conn: CH.conn(), creator: w, quoteMint, name, symbol, uri: cleanUrl(body.uri) || '',
          transferHookProgram: hook?.program || null,
          rule: chosen?.rule || null,
          ruleParams: chosen?.params || null,
          // Baked into the mint for good; the client saves the metadata row before it signs, so the
          // JSON is already answering by the time the mint exists on chain.
          uriBase: `${originOf(req)}/api/meta`,
          poolFeeBps: Math.max(10, Math.min(5000, Math.round(Number(body.poolFeeBps) || cfg.poolFeeBps))),
          creatorSharePct: Math.max(0, Math.min(100, Math.round(Number(body.creatorSharePct) ?? cfg.creatorSharePct))),
          initialMarketCap: capUsd / qUsd,
          migrationMarketCap: migUsd / qUsd,
          quoteDecimals,
          devBuy,
          decayFromBps: body.decayFromBps ? Math.min(5000, Math.round(Number(body.decayFromBps))) : null,
          decaySeconds: Math.max(0, Math.min(3600, Math.round(Number(body.decaySeconds) || 0))),
        });
        // Each step carries its own co-signers: the config keypair signs the first transaction and
        // the mint keypair the second, and signing both with both fails.
        return json(res, 200, {
          mint: r.mint, pool: r.pool, config: r.config,
          // The hooked path defers the dev buy until the rule is on; the client runs it after the
          // last step lands. "0" on every other launch, where it is still bundled into the pool tx.
          devBuyAfter: r.devBuyAfter,
          rule: chosen ? { key: chosen.rule.key, label: chosen.rule.label, program: chosen.rule.program.toBase58(), summary: chosen.summary } : null,
          steps: r.steps.map((st) => ({
            label: st.label,
            tx: Buffer.from(st.tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
            signers: st.signers.map((k) => Buffer.from(k.secretKey).toString('base64')),
          })),
        });
      }
      // Record a DBC launch once its transactions have landed. Separate from the build so a user who
      // abandons the wallet prompt does not leave a phantom coin in the list.
      // ---- trading a coin that lives on Meteora DBC ----------------------------------------
      // A coin on the `dbc` venue is traded by Meteora's program, so our own build/buy and
      // build/sell (which drive OUR curve program) cannot touch it. Without these two routes a
      // Meteora launch is untradeable everywhere: our buy box has no path, and no aggregator will
      // route through a curve whose real quote reserve is still zero — so the first trade, which is
      // what creates that reserve, can only be made here.
      // The protocol's own side of the same pool. Separate from the creator claim because it is a
      // different field, a different signer and a different pot of money.
      if (sub === 'build/dbc-claim-partner') {
        const t = E.getToken.get(String(body.mint || ''));
        if (!t?.dbc_pool || !t?.dbc_config) return json(res, 404, { error: 'not a Meteora coin' });
        const MET = await import('./lib/meteora.mjs');
        // ⛔ Ask the POOL CONFIG who may claim rather than trusting our own wallet list — the config
        // is what the Meteora program will actually check, and a mismatch here would build a
        // transaction that can only fail at signing time.
        const claimer = await CH.readWithRetry(() => MET.feeClaimerOf(CH.conn(), t.dbc_config));
        if (!claimer) return json(res, 503, { error: 'Could not read the pool config just now — try again in a moment' });
        if (claimer !== w) return json(res, 403, { error: `Only ${claimer.slice(0, 8)}… can claim the protocol's side of this pool.` });
        const f = await CH.readWithRetry(() => MET.partnerFeesOf(CH.conn(), t.dbc_pool));
        if (!f) return json(res, 503, { error: 'Could not read the pool just now — try again in a moment' });
        if (f.quote === 0n && f.base === 0n) return json(res, 400, { error: 'Nothing to claim yet' });
        return json(res, 200, await MET.buildClaimPartnerTx({
          conn: CH.conn(), feeClaimer: w, pool: t.dbc_pool, quoteMint: t.quote_mint, maxBase: f.base, maxQuote: f.quote }));
      }
      if (sub === 'build/dbc-claim-creator') {
        const t = E.getToken.get(String(body.mint || ''));
        if (!t?.dbc_pool) return json(res, 404, { error: 'not a Meteora coin' });
        if (t.creator !== w) return json(res, 403, { error: 'Only the launcher can claim a coin\'s creator fees' });
        const MET = await import('./lib/meteora.mjs');
        // Retried, because this is the read behind a button: see CH.readWithRetry.
        const f = await CH.readWithRetry(() => MET.creatorFeesOf(CH.conn(), t.dbc_pool));
        if (!f) return json(res, 503, { error: 'Could not read the pool just now — try again in a moment' });
        if (f.quote === 0n && f.base === 0n) return json(res, 400, { error: 'Nothing to claim yet' });
        // ⛔ THE SHARERS ARE PAID INSIDE THIS TRANSACTION, so the claim and their slice settle
        // atomically: either the creator receives their fee and the sharers receive theirs, or
        // neither happens. Taking the slice before the creator sees it would mean routing their
        // money through us, which is custody of other people's funds for a referral feature.
        const SH = await import('./lib/sharers.mjs');
        const decq = t.quote_mint ? await MET.quoteDecimalsOf(CH.conn(), t.quote_mint) : null;
        let plan = { bps: 0, accrue: [], pay: [], carried: 0 };
        if (Number.isInteger(decq)) {
          try {
            plan = SH.sharerPlan({ token: t, claimedRaw: f.quote, decimals: decq, rexHeldUsd: E.rexHeldUsd });
          } catch (e) { warn('sharer plan', e.message); }   // never block a creator's own claim
        }
        const built = await MET.buildClaimCreatorTx({
          conn: CH.conn(), creator: w, pool: t.dbc_pool, quoteMint: t.quote_mint,
          maxBase: f.base, maxQuote: f.quote, pay: plan.pay });
        // Say what is wrong in words rather than letting the wallet show a simulation dump.
        const why = await MET.explainBeforeSending(CH.conn(), built.tx);
        if (why) return json(res, 400, { error: why });
        // ⛔ ACCRUE ONLY WHEN THE TRANSACTION IS BUILT, SETTLE ONLY WHEN IT CONFIRMS. A built
        // transaction is not a sent one; `owed` goes up here and only comes down in
        // creator/claimed, from what was actually read off the chain.
        if (plan.accrue.length && Number.isInteger(decq)) SH.accrueOwed(t.mint, plan.accrue, decq);
        return json(res, 200, { ...built,
          // So the creator sees exactly who is being paid, and how much, BEFORE they sign.
          sharers: plan.pay.map((r) => ({ wallet: r.referrer, amount: Number(r.amountRaw) / 10 ** (decq || 0) })),
          sharerBps: plan.bps, sharerCarried: plan.carried, quoteSymbol: t.quote });
      }
      if (sub === 'build/claim-creator') {
        const t = E.getToken.get(String(body.mint || ''));
        if (!t) return json(res, 404, { error: 'not found' });
        if (t.creator !== w) return json(res, 403, { error: 'Only the launcher can claim a coin\'s creator fees' });
        return json(res, 200, await CH.buildClaimCreator({ creator: w, mint: t.mint }));
      }
      // Record a claim that landed, so the dashboard can show a lifetime figure. The CHAIN is
      // always the authority for what is still owed; this only tracks what went out through here.
      //
      // ⛔ THE AMOUNT IS READ FROM THE TRANSACTION, NOT TAKEN FROM THE CALLER. This used to record
      // `body.amount` verbatim, which is how STNKOG's dashboard came to claim 344.69 STONK of
      // creator fees against the 0.345 that actually moved: the figure was computed in a browser
      // that had the quote at 6 decimals when the mint says 9. A money figure a caller supplies is
      // a money figure a caller can invent, and there is no need to accept one — the signature
      // names a transaction whose own balance deltas say exactly what the creator received.
      // ⛔ EVERY COIN LAUNCHED BEFORE TODAY LOST ITS SHARE & EARN CHOICE, because nothing stored
      // it. That is unrecoverable — the number was never written down — so the creator needs a way
      // to state it again rather than being stuck at zero for the life of the coin.
      if (sub === 'creator/share') {
        const t = E.getToken.get(String(body.mint || ''));
        if (!t) return json(res, 404, { error: 'not found' });
        if (t.creator !== w) return json(res, 403, { error: 'Only the launcher can set this' });
        const bps = Math.max(0, Math.min(10_000, Math.round(Number(body.refShareBps) || 0)));
        const cut = E.creatorCutBps(t);
        if (bps > 0 && cut <= 0) {
          return json(res, 400, { error: 'This coin takes no creator fee, so there is nothing to share out of.' });
        }
        db.prepare('UPDATE tokens SET ref_share_bps=? WHERE mint=?').run(bps, t.mint);
        log(`share&earn ${t.symbol} -> ${bps}bps by ${w.slice(0, 6)}`);
        return json(res, 200, { ok: true, refShareBps: bps,
          refShareOfTradeBps: Math.round(cut * bps / 10_000) });
      }
      if (sub === 'creator/claimed') {
        const t = E.getToken.get(String(body.mint || ''));
        if (!t || t.creator !== w) return json(res, 403, { error: 'not yours' });
        const sig = String(body.sig || body.signature || '');
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(sig)) return json(res, 400, { error: 'a signature is required' });
        let got = 0;
        try {
          const txn = await CH.conn().getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          if (!txn || txn.meta?.err) return json(res, 400, { error: 'that transaction did not land' });
          const mine = (b) => b.owner === w && b.mint === t.quote_mint;
          const sum = (list) => (list || []).filter(mine)
            .reduce((a, b) => a + Number(b.uiTokenAmount?.uiAmount || 0), 0);
          got = sum(txn.meta?.postTokenBalances) - sum(txn.meta?.preTokenBalances);
          // A SOL-quoted pool pays in lamports, which carry no token balance entry at all.
          if (!(got > 0) && t.quote === 'SOL') {
            const i = txn.transaction.message.staticAccountKeys?.findIndex((k) => k.toBase58() === w);
            if (i >= 0) got = (Number(txn.meta.postBalances[i]) - Number(txn.meta.preBalances[i])) / 1e9;
          }
        } catch (e) {
          // Not recording is the right failure: the lifetime figure is a nicety, a wrong one is not.
          warn('creator claim', `could not read ${sig.slice(0, 12)}…: ${e.message}`);
          return json(res, 503, { error: 'could not read that transaction just now' });
        }
        if (got > 0) E.recordCreatorClaim(t.mint, got);
        // ⛔ WHAT THE SHARERS WERE ACTUALLY PAID, READ OFF THE SAME TRANSACTION. Decrementing
        // `owed` from the plan would forgive a debt that a cancelled wallet prompt never paid.
        try {
          const SH = await import('./lib/sharers.mjs');
          const txn = await CH.conn().getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          const paidBy = {};
          const keys = txn?.transaction?.message?.staticAccountKeys || [];
          // Token transfers show as balance deltas; a SOL claim pays sharers in native lamports.
          const pre = Object.fromEntries((txn?.meta?.preTokenBalances || []).map((b) => [b.owner + ':' + b.mint, Number(b.uiTokenAmount?.uiAmount || 0)]));
          for (const b of (txn?.meta?.postTokenBalances || [])) {
            if (b.mint !== t.quote_mint || b.owner === w) continue;
            const d = Number(b.uiTokenAmount?.uiAmount || 0) - (pre[b.owner + ':' + b.mint] || 0);
            if (d > 0) paidBy[b.owner] = (paidBy[b.owner] || 0) + d;
          }
          if (t.quote === 'SOL') {
            for (let i = 0; i < keys.length; i++) {
              const who = keys[i].toBase58();
              if (who === w) continue;
              const d = (Number(txn.meta.postBalances[i]) - Number(txn.meta.preBalances[i])) / 1e9;
              if (d > 0) paidBy[who] = (paidBy[who] || 0) + d;
            }
          }
          const settled = SH.settlePaid(t.mint, paidBy);
          if (settled > 0) log(`share&earn ${t.symbol}: ${settled} paid to ${Object.keys(paidBy).length} sharer(s)`);
        } catch (e) { warn('sharer settle', e.message); }
        return json(res, 200, { ok: true, recorded: got > 0 ? got : 0 });
      }
      if (sub === 'dbc/quote') {
        const t = E.getToken.get(String(body.mint || ''));
        if (!t?.dbc_pool) return json(res, 404, { error: 'not a Meteora coin' });
        const MET = await import('./lib/meteora.mjs');
        const sell = !!body.sell;
        try {
          const amountIn = amt(body.amountIn);
          const q = await MET.quoteSwap({ conn: CH.conn(), pool: t.dbc_pool, amountIn,
            swapBaseForQuote: sell, slippageBps: Math.max(1, Math.min(5000, Math.round(Number(body.slippageBps) || 100))) });
          // Price impact, measured rather than modelled: price the same trade at a hundredth of the
          // size and compare. A brand-new curve is thin enough that impact is the single number a
          // first buyer most needs, and deriving it from OUR curve's maths would be a confident
          // statement about a pool we do not own. If this reference quote fails the field is simply
          // absent and the client shows a dash — a dash means "not known", never "zero".
          let impact = null;
          try {
            const ref = BigInt(amountIn) / 100n;
            if (ref > 0n && q.out > 0n) {
              const r2 = await MET.quoteSwap({ conn: CH.conn(), pool: t.dbc_pool, amountIn: ref, swapBaseForQuote: sell, slippageBps: 100 });
              if (r2.out > 0n) {
                const px = Number(amountIn) / Number(q.out), spot = Number(ref) / Number(r2.out);
                if (spot > 0) impact = px / spot - 1;
              }
            }
          } catch (e) { warn('dbc impact', e.message); }
          return json(res, 200, { out: String(q.out), minOut: String(q.minOut), fee: String(q.fee), ...(impact == null ? {} : { impact }) });
        } catch (e) {
          // ⛔ "Insufficient Liquidity" IS A REFUSAL, NOT AN ANSWER. A bonding curve holds a finite
          // amount of base, so a buy past the end of it cannot fill — and the moment everybody
          // wants in is the moment the curve is thinnest. Say what size WOULD work.
          if (/Insufficient Liquidity/i.test(e.message || '')) {
            try {
              const dec = t.quote_mint ? await MET.quoteDecimalsOf(CH.conn(), t.quote_mint) : null;
              const max = await MET.maxFillable({ conn: CH.conn(), pool: t.dbc_pool,
                swapBaseForQuote: sell, slippageBps: 100, upper: amt(body.amountIn) });
              if (max > 0n && Number.isInteger(dec)) {
                // Round DOWN to something a person can read and retype. Rounding up would name a
                // size that does not fill, which is worse than the refusal it replaces.
                const exact = Number(max) / 10 ** dec;
                const step = 10 ** Math.max(0, 4 - Math.max(0, Math.ceil(Math.log10(exact || 1))));
                const ui = Math.floor(exact * step) / step;
                return json(res, 400, { error: sell
                  ? `This curve can only absorb about ${ui} ${t.quote} of selling right now — sell less, or in pieces.`
                  : `There is only about ${ui} ${t.quote} of room left on this curve right now, and that is all`
                    + ' it can fill. Try that amount or less.', maxIn: String(max) });
              }
              if (max === 0n) {
                return json(res, 400, { error: 'This curve has nothing left to fill — the coin has cleared it.' });
              }
            } catch (e2) { warn('maxFillable', e2.message); }
          }
          return json(res, 400, { error: e.message });
        }
      }
      if (sub === 'build/dbc-buy' || sub === 'build/dbc-sell') {
        if (throttled('trade', w, req, 250, 120)) return json(res, 429, { error: 'Slow down' });
        const t = E.getToken.get(String(body.mint || ''));
        if (!t?.dbc_pool) return json(res, 404, { error: 'not a Meteora coin' });
        const MET = await import('./lib/meteora.mjs');
        const sell = sub === 'build/dbc-sell';
        // ⛔ A HOOKED COIN WHOSE RULE WAS NEVER SWITCHED ON CANNOT BE TRADED BY ANYONE, and the
        // program says so as `6071 missingRemainingAccountForTransferHook` — which reaches a
        // person as a raw error code and reaches us as "some tokens don't work even if we release
        // that way". $B24837 and $KT are both in this state: the mint points at the hook program,
        // but the per-mint extra-account-meta list it needs was never created, so the token
        // program reverts every transfer. Say it plainly instead of letting the swap fail.
        if (t.hook_program) {
          try {
            const { ruleIsOn } = await import('./lib/hooked.mjs');
            if (!(await ruleIsOn(t.mint, t.hook_program))) {
              return json(res, 400, { error: `$${t.symbol} carries a transfer rule that was never switched on, so no`
                + ' wallet can send or receive it — buying and selling are both impossible until the launcher'
                + ' completes it. Nothing was sent. This has been reported.', ruleNotInitialised: true });
            }
          } catch (e) { warn('rule check', e.message); }   // unreadable is not the same as absent
        }
        const swap = await MET.buildSwapTx({
          conn: CH.conn(), owner: w, pool: t.dbc_pool, quoteMint: t.quote_mint, baseMint: t.mint,
          amountIn: amt(body.amountIn), minimumAmountOut: amt(body.minimumAmountOut),
          swapBaseForQuote: sell,
        });
        // ⛔ EVERY SOL-PAIRED BUY ON THIS SITE FAILED FOR DAYS and the only thing anyone saw was a
        // wallet's simulation dump. Simulate here and say what is wrong in a sentence instead.
        const no = await MET.explainBeforeSending(CH.conn(), swap.tx, { action: sell ? 'sell' : 'buy' });
        if (no) return json(res, 400, { error: no });
        return json(res, 200, swap);
      }
      // ---------------------------------------------------------------- LaunchLab: record + trade
      if (sub === 'll/confirm') {
        const LL = await import('./lib/launchlab.mjs');
        const mint = String(body.mint || ''), pool = String(body.pool || '');
        if (!isWallet(mint) || !isWallet(pool)) return json(res, 400, { error: 'bad mint or pool' });
        const name = cleanText(body.name, 32);
        const symbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        if (name.length < 2 || symbol.length < 2) return json(res, 400, { error: 'Name and ticker are too short' });
        // ⛔ TRUST THE CHAIN, NOT THE CALLER, AND CHECK OWNERSHIP RATHER THAN EXISTENCE. Any funded
        // address passes an existence check — the DBC version of this once accepted the System
        // Program as a pool. The account has to belong to the LaunchLab program to be a pool.
        const live = await CH.conn().getAccountInfo(new (await import('@solana/web3.js')).PublicKey(pool));
        if (!live) return json(res, 400, { error: 'no account at that pool address yet' });
        if (!live.owner.equals(LL.LL_PROGRAM)) return json(res, 400, { error: 'that address is not a LaunchLab pool' });
        let image = null;
        try { image = saveImage(body.image); } catch (e) { warn('ll confirm image', e.message); }
        IX.saveDbcLaunch({ ...body, mint, pool, config: String(body.config || ''), creator: w,
          name, symbol, image, hookProgram: null, venue: 'launchlab' });
        return json(res, 200, { ok: true });
      }
      if (sub === 'll/quote' || sub === 'build/ll-buy' || sub === 'build/ll-sell') {
        const LL = await import('./lib/launchlab.mjs');
        const t = E.getToken.get(String(body.mint || ''));
        if (!t || t.venue !== 'launchlab') return json(res, 404, { error: 'not a LaunchLab coin' });
        const Q = LL.llQuoteOf(t.quote_mint);
        if (!Q) return json(res, 400, { error: 'this coin\'s pair has no LaunchLab curve' });
        const sell = sub === 'build/ll-sell' || (sub === 'll/quote' && !!body.sell);
        const slippageBps = Math.max(10, Math.min(3000, Math.round(Number(body.slippageBps) || 300)));
        const quoteOnly = sub === 'll/quote';
        if (!quoteOnly && throttled('trade', w, req, 250, 120)) return json(res, 429, { error: 'Slow down' });
        try {
          const r = sell
            ? await LL.llSell({ owner: w, mint: t.mint, Q, creator: t.creator,
                amountRaw: String(amt(body.amountIn)), slippageBps, quoteOnly })
            : await LL.llBuy({ owner: w, mint: t.mint, Q, creator: t.creator,
                amountIn: Number(body.amountIn) / 10 ** Q.dec, slippageBps, quoteOnly });
          if (quoteOnly) return json(res, 200, { ...r, outRaw: undefined });
          const { Transaction, PublicKey } = await import('@solana/web3.js');
          const tx = new Transaction();
          for (const ix of r.ixs) tx.add(ix);
          tx.feePayer = new PublicKey(w);
          tx.recentBlockhash = (await CH.conn().getLatestBlockhash('confirmed')).blockhash;
          const b64 = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
          // The same courtesy the Meteora path gives: say what is wrong before a wallet is asked.
          const MET = await import('./lib/meteora.mjs');
          const why = await MET.explainBeforeSending(CH.conn(), b64, { action: sell ? 'sell' : 'buy' });
          if (why) return json(res, 400, { error: why });
          return json(res, 200, { tx: b64 });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (sub === 'dbc/confirm') {
        const MET = await import('./lib/meteora.mjs');
        const mint = String(body.mint || ''), pool = String(body.pool || ''), config = String(body.config || '');
        if (!isWallet(mint) || !isWallet(pool)) return json(res, 400, { error: 'bad mint or pool' });
        const name = cleanText(body.name, 32);
        const symbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        if (name.length < 2 || symbol.length < 2) return json(res, 400, { error: 'Name and ticker are too short' });
        // Trust the chain, not the caller — and check OWNERSHIP, not mere existence. Any funded
        // address passes an existence check: the first version of this accepted the System Program
        // as a pool. The account has to belong to the DBC program for it to be a pool at all.
        const live = await CH.conn().getAccountInfo(new (await import('@solana/web3.js')).PublicKey(pool));
        if (!live) return json(res, 400, { error: 'no account at that pool address yet' });
        if (live.owner.toBase58() !== MET.DBC_PROGRAM_ID) return json(res, 400, { error: 'that address is not a Meteora pool' });
        // ⛔ ASK THE MINT, NOT THE FORM. Whether this coin can refuse transfers is the single most
        // important thing a future buyer needs to know, and the one field the launcher has a motive
        // to leave out. It is on chain and immutable, so it is read from there and stamped here.
        let hookProgram = null;
        try { hookProgram = await MET.hookOfMint(CH.conn(), mint); }
        catch (e) { warn('confirm hook', e.message); }
        // ⛔ `...body` CARRIES THE CLIENT'S RAW `image`, WHICH IS A data: URL.
        // /api/chain/meta saved the artwork to a file and recorded "/img/xyz.png" moments earlier;
        // spreading the body here then overwrote that path with 632 KB of inline base64 ($BITE).
        // Two consequences, both bad: every API response carrying that token shipped the blob, and
        // NO EXTERNAL PLATFORM CAN EVER USE A data: URL — not a wallet, not a scanner, not fomo —
        // so the metadata JSON would have pointed at something unusable even once it existed.
        // Store a file or store nothing; never let the raw upload reach the column.
        let image = null;
        try { image = saveImage(body.image); } catch (e) { warn('dbc confirm image', e.message); }
        IX.saveDbcLaunch({ ...body, mint, pool, config, creator: w, name, symbol, image, hookProgram });
        return json(res, 200, { ok: true, links: MET.explorerLinks(mint) });
      }
      if (sub === 'meta') { // off-chain parts of a launch, saved before the create tx is signed
        const mint = String(body.mint || ''); if (!isWallet(mint)) return json(res, 400, { error: 'bad mint' });
        let image = null; try { image = saveImage(body.image); } catch (e) { return json(res, 400, { error: e.message }); }
        if (!image) return json(res, 400, { error: 'An image is required' });
        const name = cleanText(body.name, 32), symbol = String(body.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        if (name.length < 2 || symbol.length < 2) return json(res, 400, { error: 'Name and ticker are too short' });
        // ⛔ THE LAST POINT A BAD PAYOUT BASKET CAN STILL BE STOPPED. This route is the off-chain
        // half of a launch and runs BEFORE the create transaction is signed; by dbc/confirm the
        // pool exists, the creator has paid for it, and refusing it there would strand a live pool
        // with no row. Check it here, where the answer is still a form error and not a loss.
        const basket = E.normalizeBasket(body.payoutAssets);
        if (basket.error) return json(res, 400, { error: `Payout basket: ${basket.error}` });
        IX.saveMeta({ mint, name, symbol, description: cleanText(body.description, 600), image, website: E.cleanLink(body.website), twitter: E.cleanLink(body.twitter), telegram: E.cleanLink(body.telegram), creator: w, rewardMode: body.rewardMode });
        return json(res, 200, { ok: true, image });
      }
      if (sub === 'faucet' && m === 'POST') {
        if (!cfg.faucetMint) return json(res, 404, { error: 'faucet is not enabled' });
        if (throttled('faucet', w, req, 60_000, 10_000)) return json(res, 429, { error: 'One faucet request per minute' });
        // Which asset — so META, ALTS and Stocks pairs can be traded against, not merely launched.
        return json(res, 200, await CH.faucet(w, undefined, cleanText(body.symbol, 12)));
      }
      // One click behind "you hold it, but the pool cannot reach it". Signed by the holder; the
      // server only assembles the transfers.
      if (sub === 'consolidate' && m === 'POST') {
        const mint = String(body.mint || '');
        if (!isWallet(mint)) return json(res, 400, { error: 'bad mint' });
        if (throttled('consolidate', w, req, 2000, 1000)) return json(res, 429, { error: 'Slow down' });
        return json(res, 200, await CH.buildConsolidate(w, mint));
      }
      if (sub === 'claimable' && m === 'POST') return json(res, 200, { claims: IX.claimable(w) });
      if (sub === 'simulate') return json(res, 200, await CH.simulate(String(body.tx || '')));
      if (sub === 'send') { const sig = await CH.send(String(body.tx || '')); return json(res, 200, { signature: sig }); }
      return json(res, 404, { error: 'not found' });
    } catch (e) { warn('chain', sub, e.message); return json(res, 400, { error: e.message }); }
  }

  // Every dividend pick a model has made for one coin, newest first — the record the launch form
  // promises. A decision nobody can read is a decision nobody should trust, and this is the only
  // place the reason behind an asset change exists.
  // ⛔ PROVE THE MODEL IS ACTUALLY REACHABLE. /api/state reports `ai.dividend` from `!!cfg.aiKey`
  // alone, which a truncated, revoked or wrong-workspace key satisfies just as well as a working
  // one — and nothing calls the model until a coin opts into the mode, so a broken key stays
  // invisible until a holder is paid in the wrong asset. This spends one model call to answer the
  // question directly. Admin-gated because it costs money and reports the configured endpoint.
  if (p === '/api/ai/probe' && m === 'GET') {
    if (!(await adminOk())) return;
    const r = await AI.probeModel();
    return json(res, r.ok ? 200 : 502, r);
  }

  const aim = /^\/api\/ai\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  if (aim && m === 'GET') return json(res, 200, { mode: E.aiModeOf(E.getToken.get(aim[1])?.ai_mode), assets: AI.dividendAssets(), decisions: AI.decisions(aim[1], 50) });

  // Recipes — "when this, then that". The vocabulary is served so the builder and the validator can
  // never disagree about what can be wired to what.
  if (p === '/api/recipes/vocabulary') {
    const R = await import('./lib/recipes.mjs');
    return json(res, 200, R.vocabulary());
  }
  let rm = /^\/api\/recipes\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  if (rm) {
    const R = await import('./lib/recipes.mjs');
    const mint = rm[1];
    if (m === 'GET') return json(res, 200, { recipes: R.list(mint), fires: R.fires(mint, 25) });
    if (m === 'POST') {
      const t = E.getToken.get(mint);
      if (!t) return json(res, 404, { error: 'no such coin' });
      // Only the launcher writes rules that spend that launch's fees.
      if (!wallet || wallet !== t.creator) return json(res, 403, { error: 'only the creator can set recipes' });
      const r = R.save(mint, body);
      return json(res, r.ok ? 200 : 400, r);
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  // The split stopped being on-chain, so it is published instead. Anyone can add these up.
  if (p === '/api/fees') {
    const F = await import('./lib/fees.mjs');
    const mint = new URL(req.url, 'http://x').searchParams.get('mint');
    return json(res, 200, F.ledger(mint && isWallet(mint) ? mint : null));
  }
  // ---------- payouts: the money path OUT
  // ⛔ Everything above this point only ever RECORDED a division. These four routes are what turns
  // a bucket column into a transfer. See lib/payout.mjs for the ordering discipline.
  if (p === '/api/payouts' && m === 'GET') {
    const who = new URL(req.url, 'http://x').searchParams.get('wallet') || wallet;
    if (!isWallet(who)) return json(res, 400, { error: 'bad wallet' });
    const PO = await import('./lib/payout.mjs');
    const due = PO.holderDue(who);
    const usd = due.reduce((a, g) => a + g.total * (usdOf(g.quote) || 0), 0);
    return json(res, 200, {
      wallet: who, due: due.map((g) => ({ quote: g.quote, quoteMint: g.quoteMint, amount: g.total, rows: g.rows.length })),
      usd, payable: PO.canPay(),
      paid: db.prepare(`SELECT p.mint, t.symbol, t.quote, p.amount, p.paid_at, p.claim_sig
                        FROM payouts p JOIN tokens t ON t.mint=p.mint
                        WHERE p.wallet=? AND p.claim_sig IS NOT NULL ORDER BY p.ts DESC LIMIT 50`).all(who),
    });
  }
  if (p === '/api/payouts/claim' && m === 'POST') {
    if (!need()) return;
    if (!CH.enabled()) return json(res, 503, { error: 'on-chain mode is off' });
    if (!throttle('claim', wallet, 5000)) return json(res, 429, { error: 'One claim at a time — give the last one a moment to land.' });
    const PO = await import('./lib/payout.mjs');
    if (!PO.canPay()) return json(res, 503, { error: 'Payouts are not configured on this deployment yet.' });
    try {
      const r = await PO.payHolder({ conn: CH.conn(), CH, wallet, execute: true });
      if (r.error) return json(res, 400, { error: r.error === 'nothing owed' ? 'You have nothing to claim yet.' : r.error });
      if (r.failed && !r.sent) return json(res, 502, { error: 'The transfer did not land. Nothing was deducted — try again shortly.' });
      return json(res, 200, { ok: true, ...r });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // The public record of every send, so the division can be checked without trusting this database.
  if (p === '/api/payouts/sends' && m === 'GET') {
    const PO = await import('./lib/payout.mjs');
    return json(res, 200, { sends: PO.sends(100) });
  }
  // Protocol distribution. Gated to the wallets the CHAIN says get paid, exactly like /api/admin/king,
  // and a dry run unless `execute` is explicitly set — moving the treasury is a deliberate act.
  if (p === '/api/admin/payouts/run' && m === 'POST') {
    if (!(await adminOk())) return;
    const PO = await import('./lib/payout.mjs');
    try {
      const r = await PO.payProtocol({ conn: CH.conn(), CH, execute: body.execute === true });
      return json(res, 200, { ok: true, executed: body.execute === true, ...r });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/rewards') { const o = await RW.overview(); return o ? json(res, 200, o) : json(res, 503, { error: 'rewards service unreachable' }); }
  if (p === '/api/rewards/holder') { const w = new URL(req.url, 'http://x').searchParams.get('w') || ''; if (!isWallet(w)) return json(res, 400, { error: 'bad wallet' }); const h = await RW.holder(w); return h ? json(res, 200, h) : json(res, 503, { error: 'rewards service unreachable' }); }
  // ---------- callouts: call a coin in public, earn on what it brings (Elio, 7 Oct — "let's add")
  if (p === '/api/callouts' && m === 'GET') {
    const u = new URL(req.url, 'http://x');
    const mint = u.searchParams.get('mint');
    const who = u.searchParams.get('wallet');
    if (mint && !isWallet(mint)) return json(res, 400, { error: 'bad mint' });
    if (who && !isWallet(who)) return json(res, 400, { error: 'bad wallet' });
    return json(res, 200, {
      callouts: CALL.feed({ mint, wallet: who, limit: Number(u.searchParams.get('limit')) || 40 }),
      ...CALL.stats(),
    });
  }
  if (p === '/api/callouts' && m === 'POST') { if (!need()) return;
    if (!throttled('callout', wallet, req, 10_000, 5_000)) return json(res, 429, { error: 'Slow down' });
    if (!isWallet(String(body.mint || ''))) return json(res, 400, { error: 'bad mint' });
    const r = CALL.post(wallet, String(body.mint), body.text, body.xUrl);
    if (r.ok) broadcast({ type: 'callout', mint: String(body.mint), wallet, who: nameOf(wallet) });
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/api/callouts/board' && m === 'GET') {
    const u = new URL(req.url, 'http://x');
    return json(res, 200, { board: CALL.board({ limit: Number(u.searchParams.get('limit')) || 25 }).map((r) => ({ ...r, name: nameOf(r.wallet) })), ...CALL.stats() });
  }

  // ---------- post & earn: points for posting about REX Chain on X (Elio, 7 Oct)
  if (p === '/api/share' && m === 'GET') { if (!need()) return;
    return json(res, 200, { ...SHARE.stats(), posts: SHARE.forWallet(wallet) }); }
  if (p === '/api/share' && m === 'POST') { if (!need()) return;
    // ⛔ IP AND WALLET. A throttle keyed on a string the caller chose is not a throttle, and the
    // wallet in a session is ours but the submission rate is worth holding from both ends.
    if (!throttled('share', wallet, req, 4_000, 2_000)) return json(res, 429, { error: 'Slow down' });
    try {
      const r = await SHARE.submit(wallet, body.url);
      return json(res, r.ok ? 200 : 400, r);
    } catch (e) { return json(res, 400, { error: e.message }); } }
  if (p === '/api/admin/share' && m === 'GET') { if (!(await adminOk())) return;
    return json(res, 200, { queue: SHARE.queue(), ...SHARE.stats() }); }
  if (p === '/api/admin/share' && m === 'POST') { if (!(await adminOk())) return;
    const r = SHARE.decide(body.id, String(body.status || ''), body.note || null);
    return json(res, r.ok ? 200 : 400, r); }

  // ---------- the rewards distributor, driven from THIS admin page
  //
  // ⛔ THE BUTTON THAT SPENDS THE BURN POT WAS ON A SECOND SITE WITH A SECOND PASSWORD. The owner
  // went looking for it here, which is where they administer everything else, and there was nothing
  // to find — so a pot at 2.9x its threshold sat unburned for eighteen days behind a login nobody
  // was in front of. The two controls that matter now live on the page people actually open.
  //
  // The shared key is a Fly secret on both apps and never reaches a browser; the owner-wallet check
  // above is what authorises the call, exactly as it does for every other route in this block.
  if (p === '/api/admin/rewards' && m === 'GET') { if (!(await adminOk())) return;
    try { return json(res, 200, await REWARDS.adminState()); }
    catch (e) { return json(res, 502, { error: e.message }); } }
  if (p === '/api/admin/rewards' && m === 'POST') { if (!(await adminOk())) return;
    const act = String(body.action || '');
    if (!['auto', 'manual', 'run'].includes(act)) return json(res, 400, { error: 'action must be auto, manual or run' });
    try { return json(res, 200, await REWARDS.adminDo(act, wallet)); }
    catch (e) { return json(res, 502, { error: e.message }); } }

  // ---------- social / growth
  if (p === '/api/ref/wallet' && m === 'POST') { if (!need()) return;
    // Platform-level: whoever brought this wallet to REX Chain earns on every token it ever launches.
    const by = E.walletForRefCode(String(body.code || ''));
    if (!by) return json(res, 400, { error: 'unknown code' });
    return json(res, 200, { boundTo: E.attributeWallet(wallet, by) }); }
  if (p === '/api/ref' && m === 'POST') { if (!need()) return;
    // Bind the visitor to whoever brought them, by short code. First touch wins, so this is safe to
    // call on every page view.
    const by = E.walletForRefCode(String(body.code || '')); const mint = String(body.mint || '');
    if (!by || !E.getToken.get(mint)) return json(res, 400, { error: 'unknown code or token' });
    const bound = E.attributeReferral(mint, wallet, by);
    return json(res, 200, { boundTo: bound, me: E.refStatsFor(wallet, mint) }); }
  if (p === '/api/ref/me' && m === 'GET') { if (!need()) return;
    const u = new URL(req.url, 'http://x'); const mint = u.searchParams.get('mint');
    return json(res, 200, { summary: E.refSummary(wallet), token: mint ? E.refStatsFor(wallet, mint) : null }); }
  if (p === '/api/rep') { const u = new URL(req.url, 'http://x'); const w = u.searchParams.get('w') || wallet;
    if (!w) return json(res, 400, { error: 'no wallet' });
    return json(res, 200, { wallet: w, who: nameOf(w), reputation: E.reputationOf(w), creator: E.creatorHistory(w) }); }
  if (p === '/api/milestones') { const u = new URL(req.url, 'http://x'); const mint = u.searchParams.get('mint');
    return json(res, 200, { milestones: mint ? E.milestonesOf(mint) : E.recentMilestones(24) }); }
  if (p === '/api/ref/top') { const u = new URL(req.url, 'http://x');
    const mint = u.searchParams.get('mint');
    return json(res, 200, { top: E.topReferrers(mint, 20).map((r) => ({ ...r, who: nameOf(r.wallet) })) }); }
  // ---------- affiliate tree, feedback and the admin panel (Elio, 5 Oct)
  if (p === '/api/ref/tree' && m === 'GET') {
    const u = new URL(req.url, 'http://x');
    const who = u.searchParams.get('wallet') || wallet;
    if (!isWallet(who)) return json(res, 400, { error: 'bad wallet' });
    const depth = Math.max(1, Math.min(8, Number(u.searchParams.get('depth')) || 5));
    const tree = E.affiliateTree(who, { maxDepth: depth });
    return json(res, 200, { ...tree, who: nameOf(who),
      levels: tree.levels.map((l) => ({ ...l, members: l.members.map((m2) => ({ ...m2, who: nameOf(m2.wallet) })) })) });
  }
  if (p === '/api/ref/inviters') {
    return json(res, 200, { top: E.topInviters(20).map((r) => ({ ...r, who: nameOf(r.wallet) })) });
  }
  // ⛔ ANONYMOUS ON PURPOSE. Requiring a wallet to report a broken page silences exactly the people
  // who hit something broken enough to stop them connecting one.
  if (p === '/api/feedback' && m === 'POST') {
    const who = wallet || null;
    if (!throttle('feedback', who || (req.socket.remoteAddress || 'anon'), 20_000)) {
      return json(res, 429, { error: 'Thanks — give it a moment before sending another.' });
    }
    try { return json(res, 200, { ok: true, ...E.addFeedback({ wallet: who, kind: String(body.kind || 'rating'), rating: body.rating, text: body.text, page: body.page }) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/admin/feedback' && m === 'GET') {
    if (!(await adminOk())) return;
    const u = new URL(req.url, 'http://x');
    const d = E.feedbackList({ status: u.searchParams.get('status'), limit: 200 });
    return json(res, 200, { ...d, rows: d.rows.map((r) => ({ ...r, who: r.wallet ? nameOf(r.wallet) : null })) });
  }
  if (p === '/api/admin/feedback' && m === 'POST') {
    if (!(await adminOk())) return;
    try { return json(res, 200, { ok: true, row: E.setFeedbackStatus(body.id, String(body.status || 'seen'), wallet, body.note ? String(body.note).slice(0, 500) : null) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/posts' && m === 'POST') { if (!need()) return;
    if (!throttle('post', wallet, 3000)) return json(res, 429, { error: 'Slow down' });
    try { const r = E.postUpdate(wallet, String(body.mint || ''), body.text); drainEvents(); return json(res, 200, { post: r }); }
    catch (e) { return json(res, 400, { error: e.message }); } }

  // Decoration, so it is cached hard and never allowed to fail the caller.
  // What the vault has deployed and what it has earned. Public: a vault nobody can audit is a claim.
  // REX Chain's OWN buyback record — kept separate from the rewards program's figures on /rewards,
  // which come from a different system. Summing them would double-count the day both are running.
  if (p === '/api/buyback') { try { return json(res, 200, BBK.summary()); } catch { return json(res, 200, { cycles: 0, rexBought: 0, rexBurned: 0, rexHeld: 0 }); } }

  if (p === '/api/vault') { try { return json(res, 200, { ...(await VLT.summary()), positions: await VLT.positions() }); }
    catch (e) { warn('vault', e.message); return json(res, 200, { positions: 0, principalQuote: 0, earnedQuote: 0, yieldPct: 0, error: 'unavailable' }); } }

  // `list` is the bar; `featured` is the first entry, kept so a cached old client that still reads a
  // single object renders something rather than nothing while it waits for the new bundle.
  if (p === '/api/featured') {
    // The bar leads with the configured mainnet coins ($REX itself first) and then carries EVERY
    // live launch on the pad, newest first. Ale asked for more than two once launches started
    // arriving, and a bar that shows a fixed pair while the pad fills up is advertising the wrong
    // thing. Our own coins are marked `own` so the client opens their real page rather than the
    // Birdeye sheet, which exists only because external coins are not in our book.
    let list = [];
    try { list = await FEAT.featured(); } catch { list = []; }
    let launches = [];
    try {
      // Ranked by market cap, biggest first. It was launch order, which put a dead $33 coin ahead of
      // a live $15K one purely because it was newer — the bar is a shop window, not a changelog.
      // (Largest-first to match $REX leading the row; one `-` flips it if smallest-first is wanted.)
      launches = E.listTokens({ sort: 'new', limit: 40 })
        .filter((t) => t.status !== 'fairopen')
        .sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0))
        .slice(0, 24)
        .map((t) => ({
          mint: t.mint, symbol: t.symbol, name: t.name, image: t.image, quote: t.quote,
          mcapUsd: t.mcapUsd || 0, vol24Usd: (t.volume || 0) * (t.quoteUsd || 0),
          change24: t.chg24h == null ? null : t.chg24h * 100, createdAt: t.createdAt, own: true,
          external: false, cluster: cfg.rpcUrl && !/devnet/.test(cfg.rpcUrl) ? 'mainnet' : 'devnet',
        }));
    } catch (e) { warn('featured launches', e.message); }
    return json(res, 200, { featured: list[0] || null, list, launches });
  }

  // ---------- points: every bit of engagement, on one board
  // Public and unauthenticated — a scoreboard nobody can see is not a scoreboard. `me` only appears
  // when there is a signed-in wallet to speak about.
  if (p === '/api/points') {
    const qs = new URL(req.url, 'http://x').searchParams;
    const view = ['points', 'held', 'diamond'].includes(qs.get('view')) ? qs.get('view') : 'points';
    // ⛔ ONE PASS. Board + rankOf meant the whole board was built twice per request.
    const b = PTS.board({ view, limit: Math.max(1, Math.min(100, Math.floor(Number(qs.get('limit'))) || 50)), wallet });
    return json(res, 200, {
      ...b, rates: PTS.RATES,
      // The ladder and the referral shares travel with the board so the page can explain the
      // numbers rather than restating them from a second copy that drifts.
      tiers: PTS.TIERS, downline: PTS.DOWNLINE,
      breakdown: wallet ? PTS.pointsOf(wallet) : null,
      snapshots: PTS.snapshotEpochs().slice(0, 6),
    });
  }
  if (p === '/api/points/me') { if (!need()) return; return json(res, 200, { ...PTS.rankOf(wallet), breakdown: PTS.pointsOf(wallet), record: PTS.holdRecord(wallet) }); }
  mm = /^\/api\/points\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  if (mm) return json(res, 200, { breakdown: PTS.pointsOf(mm[1]), record: PTS.holdRecord(mm[1]) });

  if (p === '/api/leaderboard') { const lb = E.leaderboard(); lb.topEarners = lb.topEarners.map((x) => ({ ...x, who: nameOf(x.wallet) })); lb.diamond = lb.diamond.map((x) => ({ ...x, who: nameOf(x.wallet) })); lb.creators = lb.creators.map((x) => ({ ...x, who: nameOf(x.creator) })); return json(res, 200, lb); }
  if (p === '/api/fairopens') return json(res, 200, { tokens: E.listTokens({ status: 'fairopen', sort: 'new', limit: 24 }), king: E.kingOfTheHill() });
  if (p === '/api/feed') return json(res, 200, { feed: E.recentTrades(40).map((t) => ({ ...t, who: nameOf(t.wallet) })) });
  // Buys only, with the USD size worked out server-side. `min` lets a caller ask for size — the
  // front page shows everything, a "whale buys" view would pass min=500 — and is capped so the
  // route can never be turned into a full table scan by a querystring.
  // ---------------------------------------------------------------- open liquidity
  // Reads are public; everything that moves money is signed by the depositor's own wallet, exactly
  // like a trade. The server never holds a position and never signs for one.
  // ⛔ BOTH OF THESE WRAP getProgramAccounts, THE HEAVIEST CALL THERE IS, AND BOTH WERE OPEN TO
  // ANYONE WITH NO LIMIT. That is this morning's outage offered as a feature: a loop over random
  // base58 strings misses the cache every time and exhausts the RPC in seconds. The fix is not
  // only a throttle — a throttle still lets a patient attacker through — but a closed set of
  // things worth scanning at all.
  if (p === '/api/lp/pools') {
    const mint = String(new URL(req.url, 'http://x').searchParams.get('mint') || '');
    if (!isWallet(mint)) return json(res, 400, { error: 'bad mint' });
    // The page only ever asks about a coin this site lists or a quote asset it trades. Anything
    // else is not a user, and refusing costs nothing: an unknown mint has no pool worth showing.
    const known = !!E.getToken.get(mint) || Object.values(QUOTES).some((q) => q.mint === mint);
    if (!known) return json(res, 404, { error: 'that mint is not listed here' });
    if (!throttle('lppools', ipOf(req), 1000)) return json(res, 429, { error: 'Slow down' });
    try {
      const LP = await import('./lib/lp.mjs');
      return json(res, 200, { pools: await LP.poolsFor(CH.conn(), mint) });
    } catch (e) { return json(res, 503, { error: e.message }); }
  }
  if (p === '/api/lp/positions') {
    const u2 = new URL(req.url, 'http://x').searchParams;
    const who = String(u2.get('wallet') || '');
    if (!isWallet(who)) return json(res, 400, { error: 'bad wallet' });
    // A wallet's positions are public chain data and anyone may look, but every DISTINCT wallet is
    // another program scan, so the rate is held down per caller rather than per wallet asked about.
    if (!throttle('lppos', ipOf(req), 1500)) return json(res, 429, { error: 'Slow down' });
    const mint = u2.get('mint');
    try {
      const LP = await import('./lib/lp.mjs');
      return json(res, 200, { positions: await LP.positionsOf(CH.conn(), who, isWallet(mint || '') ? mint : null) });
    } catch (e) { return json(res, 503, { error: e.message }); }
  }
  if (p === '/api/lp/plan' && m === 'POST') {
    if (!need()) return;
    try {
      const LP = await import('./lib/lp.mjs');
      const plan = await LP.planDeposit({
        conn: CH.conn(), pool: String(body.pool || ''),
        quoteAmount: amt(body.amount), isTokenA: !!body.isTokenA,
      });
      return json(res, 200, {
        pool: plan.pool, inAmount: String(plan.inAmount), otherAmount: String(plan.otherAmount),
        isTokenA: plan.isTokenA, tokenAMint: plan.tokenAMint, tokenBMint: plan.tokenBMint,
      });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/lp/build' && m === 'POST') {
    if (!need()) return;
    if (!throttle('lp', wallet, 500)) return json(res, 429, { error: 'Slow down' });
    try {
      const LP = await import('./lib/lp.mjs');
      const act = String(body.action || 'add');
      if (act === 'add') {
        const plan = await LP.planDeposit({
          conn: CH.conn(), pool: String(body.pool || ''),
          quoteAmount: amt(body.amount), isTokenA: !!body.isTokenA,
        });
        const { tx, positionNft } = await LP.buildAddLiquidity({
          conn: CH.conn(), owner: wallet, plan,
          slippageBps: Math.max(10, Math.min(5000, Number(body.slippageBps) || 100)),
        });
        return json(res, 200, await packLpTx(tx, wallet, [positionNft]));
      }
      const common = {
        conn: CH.conn(), owner: wallet, pool: String(body.pool || ''),
        position: String(body.position || ''), positionNftAccount: String(body.positionNftAccount || ''),
      };
      if (act === 'claim') return json(res, 200, await packLpTx(await LP.buildClaimFees(common), wallet));
      if (act === 'withdraw') return json(res, 200, await packLpTx(await LP.buildWithdrawAll(common), wallet));
      return json(res, 400, { error: 'unknown action' });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  // ⛔ TAKING A SNAPSHOT IS IRREVERSIBLE BY DESIGN — the rows are written once and never updated,
  // because an allocation people have been shown must not be able to change afterwards. Admin only,
  // and it reports how many rows it actually wrote rather than how many wallets it looked at.
  if (p === '/api/admin/points/snapshot' && m === 'POST') {
    if (!adminOk(wallet)) return json(res, 403, { error: 'not an admin' });
    const epoch = Math.floor(Number(body.epoch)) || Math.floor(Date.now() / 86_400_000);
    return json(res, 200, PTS.takeSnapshot(epoch));
  }
  if (p === '/api/points/snapshot') {
    const qs2 = new URL(req.url, 'http://x').searchParams;
    // ⛔ Number(null) IS 0, NOT NaN. A missing ?epoch therefore passed Number.isFinite and the route
    // cheerfully answered for epoch 0 — one nobody has ever taken — instead of saying it was absent.
    const rawEpoch = qs2.get('epoch');
    const epoch = Math.floor(Number(rawEpoch));
    if (rawEpoch === null || rawEpoch === '' || !Number.isFinite(epoch)) return json(res, 400, { error: 'bad epoch' });
    return json(res, 200, { epoch, rows: PTS.snapshotOf(epoch, 500) });
  }
  if (p === '/api/hooks') {
    const HOOK = await import('./lib/hooked.mjs');
    return json(res, 200, { rules: HOOK.ruleList() });
  }
  // The sentence a launcher reads before signing, for the settings they have actually chosen.
  // ⛔ Computed HERE, from the same function the launch uses, so the promise on the screen and the
  // rule written on chain cannot drift apart. A copy of this logic in the browser would be a second
  // description of the same rule, and the first time they disagreed the screen would be the lie.
  if (p === '/api/hooks/preview' && m === 'POST') {
    const HOOK = await import('./lib/hooked.mjs');
    try {
      const r = await HOOK.resolveRule(String(body.key || ''), body.params || {});
      return json(res, 200, r ? { key: r.rule.key, summary: r.summary, sol: r.sol, exempt: r.rule.exempt, warn: r.rule.warn || null } : { key: null });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/buys') {
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(Number(q.get('limit')) || 30, 100);
    const minUsd = Math.max(0, Math.min(Number(q.get('min')) || 0, 1e6));
    return json(res, 200, { buys: E.recentBuys(limit, { minUsd }).map((t) => ({ ...t, who: nameOf(t.wallet) })) });
  }
  // `crank` is here so the thing that freezes launches can be watched from outside the process.
  if (p === '/api/health') return json(res, 200, { ok: true,
    // ⛔ EVERY FIELD HERE EXISTS BECAUSE SOMETHING BROKE SILENTLY AND NOBODY SAW IT FOR DAYS.
    // `rpc` is the dead-key probe; `unpricedQuotes` is how sixteen assets came to be quoted from
    // constants in the source; `undistributed` is income sitting in the pot with no send behind it.
    rpc: CH.enabled() ? CH.rpcProbe() : null,
    unpricedQuotes: unpricedQuotes(), priceSource: priceSource(),
    undistributed: (() => { try { return protocolPending(); } catch { return null; } })(),
    autoPayout: { on: process.env.PAYOUT_AUTO === '1', last: autoPayout },
    autoHolders,
    crank: CH.enabled() ? { address: CH.crankAddress(), sol: CH.crankSolCached(), stuckFairOpens: E.listTokens({ status: 'fairopen', limit: 50 }).filter((t) => t.fairOpenEnds && t.fairOpenEnds <= Date.now()).map((t) => t.symbol) } : null, tokens: db.prepare('SELECT COUNT(*) n FROM tokens').get().n, clients: clients.size, sim: cfg.sim,
    // How far the aggregator-facing promise reaches, and how far behind the live stream it is. A
    // lag that only ever grows means the backfill is stuck on something and `/dex/latest-block` has
    // (correctly) stopped moving — which is the one failure here worth paging about.
    complete: { slot: IX.completeSlot(), lag: Math.max(0, (db.prepare('SELECT MAX(slot) s FROM trades WHERE slot IS NOT NULL').get()?.s || 0) - IX.completeSlot()) } });
  return json(res, 404, { error: 'not found' });
}

process.on('uncaughtException', (e) => warn('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => warn('unhandled', e?.stack || e));
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const m = req.method;
  try {
  // ---------- the DEX Screener adapter: four endpoints they POLL, which is how a coin gets indexed
    // BEFORE it graduates. Public and unauthenticated by design — DexScreener crawls them from their
    // own infrastructure — and cached briefly because latest-block is polled every couple of seconds.
    if (p.startsWith('/dex/')) {
      const sub = p.slice('/dex/'.length);
      const ok = (body, maxAge = 2) => { res.writeHead(200, secure({ 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` }, { frame: 'DENY' })); return res.end(JSON.stringify(body)); };
      try {
        if (sub === 'latest-block') return ok(DS.latestBlock());
        if (sub === 'asset') { const a = DS.asset(u.searchParams.get('id') || ''); return a ? ok(a, 60) : json(res, 404, { error: 'unknown asset' }); }
        if (sub === 'pair') { const pr = DS.pair(u.searchParams.get('id') || ''); return pr ? ok(pr, 300) : json(res, 404, { error: 'unknown pair' }); }
        if (sub === 'events') {
          const from = Math.max(0, Math.floor(Number(u.searchParams.get('fromBlock'))));
          const to = Math.max(from, Math.floor(Number(u.searchParams.get('toBlock'))));
          if (!Number.isFinite(from) || !Number.isFinite(to)) return json(res, 400, { error: 'fromBlock and toBlock are required' });
          return ok(DS.events(from, to), 2);
        }
        return json(res, 404, { error: 'not found' });
      } catch (e) { warn('dex', sub, e.message); return json(res, 500, { error: 'adapter error' }); }
    }

    if (p.startsWith('/api/')) {
      if (rateLimited(req)) { res.writeHead(429, secure({ 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': String(Math.ceil(RATE_WINDOW_MS / 1000)) }, { frame: 'DENY' })); return res.end(JSON.stringify({ error: 'too many requests' })); }
      return await api(req, res, p, m);
    }
    // Dynamic share card: a token link unfurls with its own live numbers. Cached on disk and keyed
    // by those numbers, so a crawler hammering the same URL costs one render.
    // The embeddable card. Goes into other people's pages, so it is framable by design — the rest of
    // the site keeps its SAMEORIGIN guard.
    const em = /^\/embed\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
    if (em) {
      const tk = E.getToken.get(em[1]);
      if (!tk) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
      const html = EMB.embedHtml(E.publicToken(tk, { reward: true }), originOf(req),
        { theme: u.searchParams.get('theme'), ref: u.searchParams.get('r') });
      // The one page that is MEANT to be framed by anyone — hence its own frame-ancestors and no
      // X-Frame-Options, which would otherwise override it.
      res.writeHead(200, secure({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=30',
        'content-security-policy': "default-src 'self'; img-src 'self' data: https:; style-src 'unsafe-inline'; frame-ancestors *" },
        { frame: null }));
      return res.end(html);
    }

    // The board's own share card. Its numbers are the cache key, so it is regenerated when the
    // board moves rather than serving a confident picture of last week's volume.
    if (p === '/og/pairs.png') {
      try {
        const { totals } = E.listPairs({ window: '24h', sort: 'volume', limit: 1 });
        const file = await OG.statsCard({
          key: 'pairs',
          title: 'Pairs',
          subtitle: `Every coin paired against $REX, ranked — last 24 hours`,
          stats: [
            ['Pairs', String(totals.pairs)],
            ['24h volume', fmtMoney(totals.volumeUsd)],
            ['Rewards paid', fmtMoney(totals.rewardsUsd)],
            ['Avg realized APY', `${(totals.avgApy * 100).toFixed(1)}%`],
          ],
          line: 'Realized APY is what was actually paid out — not a projection',
        });
        res.writeHead(200, secure({ 'content-type': 'image/png', 'cache-control': 'public, max-age=120' }));
        return fs.createReadStream(file).pipe(res);
      } catch (e) { warn('og', 'pairs', e.message); res.writeHead(500); return res.end('card render failed'); }
    }

    const om = /^\/og\/([1-9A-HJ-NP-Za-km-z]{32,44})\.png$/.exec(p);
    if (om) {
      const tk = E.getToken.get(om[1]);
      if (!tk) { res.writeHead(404); return res.end('not found'); }
      try {
        const file = await OG.ogCard(E.publicToken(tk, { reward: true }));
        res.writeHead(200, secure({ 'content-type': 'image/png', 'cache-control': 'public, max-age=120' }));
        return fs.createReadStream(file).pipe(res);
      } catch (e) { warn('og', e.message); res.writeHead(500); return res.end('card render failed'); }
    }
    // ⛔ WHAT SHA IS ACTUALLY RUNNING. The standing rule is that a deploy may only ever move
    // FORWARD — the gate reads the live sha, then refuses to ship a tree that does not contain it:
    //
    //     PROD=$(curl -s https://rexpad.fly.dev/version.txt | sed 's/.*-//')
    //     git merge-base --is-ancestor "$PROD" HEAD || STOP
    //
    // That gate could not be run against this app at all, because nothing here reported a version:
    // /version.txt fell through to the SPA catch-all and answered with index.html, so the sed
    // produced a fragment of HTML and `--is-ancestor` failed open on a garbage revision. Several
    // sessions deploy this repo, so the gate is the only thing standing between a stale branch and
    // silently reverting whatever shipped while you were working. It has to be answerable.
    // Must stay ABOVE the static handler, which would otherwise swallow it again.
    // ---------------------------------------------------------------- deploying from a script
    //
    // Elio, 11 Oct: "AI agents being able to deploy (I have a homie who is making his ai agent
    // deploy 30 tokens daily)." Nothing had to be built — the whole flow was already reachable
    // over HTTP, and the only thing missing was that nobody could tell. This is that page.
    //
    // ⛔ Deliberately static and dependency-free: a docs page that needs the app shell to boot is
    // a docs page that is down whenever you most need it.
    if (p === '/developers' || p === '/developers/') {
      const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const origin = originOf(req);
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>REX Chain — deploy from a script</title>
<style>:root{--bg:#07100b;--fg:#d7f5e3;--dim:#7fa78d;--ac:#22c55e;--pa:#0d1a12}
*{box-sizing:border-box}body{margin:0;padding:32px 16px;background:var(--bg);color:var(--fg);
font:15px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:760px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px}h2{font-size:17px;margin:30px 0 8px;color:var(--ac)}
p,li{color:var(--fg)}.dim{color:var(--dim)}code,pre{background:var(--pa);border:1px solid #16301f;border-radius:8px}
code{padding:1px 5px}pre{padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word}
b.warn{color:#fbbf24}a{color:var(--ac)}</style></head><body><main>
<h1>Deploy from a script</h1>
<p class="dim">Everything the launch form does is plain HTTP. There is no separate API key: an agent
proves its wallet the same way a browser does, then signs the transactions the server builds.</p>
<p><b class="warn">&#9940; The key never leaves the agent.</b> The server returns UNSIGNED transactions.
Nothing here can launch, buy or sell on your behalf — anything that could would also be able to drain you.</p>
<h2>1 &middot; Sign in</h2>
<pre>POST ${esc(origin)}/api/auth/nonce   {"wallet":"&lt;pubkey&gt;"}
  &rarr; {"nonce":"...","message":"Sign in to REX Chain\n\nWallet: ..."}

sign <code>message</code> with the wallet key (ed25519, detached, base58)

POST ${esc(origin)}/api/auth/verify  {"wallet","nonce","signature"}
  &rarr; {"token":"..."}        send it as  Authorization: Bearer &lt;token&gt;</pre>
<h2>2 &middot; Pick a pair</h2>
<pre>GET ${esc(origin)}/api/state  &rarr; { quotes: [ { symbol, mint, decimals, unavailable } ] }</pre>
<p class="dim">A quote with <code>unavailable</code> set cannot be launched against — check it before you
build, not after you sign.</p>
<h2>3 &middot; Build, sign, send</h2>
<pre>POST /api/chain/dbc/build   { wallet, quoteMint, name, symbol,
                              initialMarketCap: 5000,     // DOLLARS, the server converts
                              migrationMarketCap: 50000,
                              devBuy,                     // the PAIR's base units
                              refShareBps }               // share &amp; earn, 0-10000
  &rarr; { mint, pool, config, steps: [ { tx, signers } ] }

POST /api/chain/meta        save name/image BEFORE signing
for each step: deserialise tx, sign with the step's signers AND your wallet,
POST /api/chain/send        { tx }
POST /api/chain/dbc/confirm records the coin once the pool exists on chain</pre>
<p><b class="warn">&#9940; Each step carries its own co-signers.</b> The config keypair signs the first
transaction and the mint keypair the next; signing both with both is rejected by the runtime.</p>
<h2>4 &middot; A working example</h2>
<p>A complete, runnable reference lives in the repo at <code>tools/agent_launch.mjs</code>:</p>
<pre>AGENT_KEY=&lt;base58 secret&gt; node tools/agent_launch.mjs \
  --name "Molten Cat" --symbol MOLT --quote SOL --dev-buy 0.05 --base ${esc(origin)}</pre>
<h2>Limits</h2>
<ul>
<li class="dim">One launch per wallet per minute. Thirty a day is comfortably inside it.</li>
<li class="dim">A launch pays Solana's rent for the mint, its metadata and the pool accounts
(~0.022&ndash;0.027 SOL). That is the network's, not ours, and cannot be waived.</li>
<li class="dim">The opening buy is paid in the PAIR asset, not in SOL — unless the pair is SOL.</li>
</ul>
</main></body></html>`;
      res.writeHead(200, secure({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }, { csp: true }));
      return res.end(html);
    }
    if (p === '/version.txt') {
      res.writeHead(200, secure({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }));
      return res.end(`rexpad-${cfg.gitSha}\n`);
    }
    if (p.startsWith('/img/')) { const f = path.join(IMG, path.basename(p)); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, secure({ 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }, { frame: 'DENY' })); return fs.createReadStream(f).pipe(res); }
    let f = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
    if (f.endsWith('index.html')) {
      // Per-route social cards. A crawler does not run the router, so whatever this writes IS the
      // preview for every link to this path, forever as far as the platform's cache is concerned.
      // lib/meta.mjs decides what each route says; this only stamps it in and makes the URLs
      // absolute, which crawlers require.
      const base = originOf(req);
      const html = fs.readFileSync(f, 'utf8');
      const md = META.metaFor(p);
      const card = `${base}${md.card || '/og.png'}`;
      // ⛔ REPLACEMENT **FUNCTIONS**, NEVER REPLACEMENT STRINGS. In a string replacement `$1` means
      // "capture group 1", and these descriptions are full of money — the moment a figure formatted
      // as "$1.09M", that `$1` was read as the backreference and the matched
      // `<meta name="description" content="` was spliced into the middle of the page's own head.
      // Every tag after it was mangled. It only hid this long because mainnet's figures are all $0;
      // the SIM book hit $1.09M and the meta test caught it immediately.
      //
      // A function replacement treats the value as literal text, so no figure can ever be read as a
      // pattern again. Same reason `card` is interpolated this way: a URL can contain `$&` too.
      const put = (re, before, value) => (h) => h.replace(re, () => before + value);
      const T = esc(md.title), D = esc(md.desc);
      const stamped = [
        (h) => h.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${T}</title>`),
        (h) => h.split('content="/og.png"').join(`content="${card}"`),
        put(/<meta property="og:title" content="[^"]*/, '<meta property="og:title" content="', T),
        put(/<meta name="twitter:title" content="[^"]*/, '<meta name="twitter:title" content="', T),
        put(/<meta name="description" content="[^"]*/, '<meta name="description" content="', D),
        put(/<meta property="og:description" content="[^"]*/, '<meta property="og:description" content="', D),
        put(/<meta name="twitter:description" content="[^"]*/, '<meta name="twitter:description" content="', D),
      ].reduce((h, f) => f(h), html)
        .replace('<head>', `<head><link rel="canonical" href="${base}${p === '/' ? '/' : p}">`
          + `<meta property="og:url" content="${base}${p === '/' ? '/' : p}">`);
      res.writeHead(200, secure({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, { csp: true })); return res.end(stamped);
    }
    res.writeHead(200, secure({ 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': /\.(html|js|css)$/.test(f) ? 'no-cache' : 'public, max-age=3600' }));
    fs.createReadStream(f).pipe(res);
  } catch (e) { warn('req', p, e.message); json(res, 500, { error: 'server error' }); }
});
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  // F2: the feed accepted an upgrade from any page on the internet. A browser cannot forge Origin,
  // so refusing an unlisted one is enough to stop a stranger's tab reading the live trade tape.
  if (!originAllowed(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

if (CH.enabled()) {
  // ⛔ NEVER LOG THE RPC URL. It carries the provider's API key in its query string, so this line
  // printed a live secret into the log stream on every boot — and it did, once, before this was
  // caught. Host and count only; the key is not ours to broadcast.
  log(`⛓  on-chain mode: program ${CH.programId().toBase58()} via ${CH.rpcHosts().join(' → ')}`);
  // ⛔ A SILENT CRANK IS A FROZEN LAUNCH. TEASURE sat in `fairopen` for 27 minutes with nobody able
  // to buy it, and the only trace was `⚠ settle Bb5jQX Simulation failed.` every 20 seconds — which
  // does not say what failed, and reads like a program bug. It was not: the crank wallet had run out
  // of SOL and could not pay a 0.000005 SOL fee. The settle instruction simulated clean the moment a
  // funded payer signed it.
  //
  // So the crank now diagnoses its own failure. A settle that fails while the cranker is empty says
  // exactly that, once per minute rather than three times a minute, and `crank` in /api/health
  // carries the balance so it can be watched from outside instead of being read off a log nobody is
  // tailing. Cheap: one balance read, and only after something has already gone wrong.
  let crankWarnedAt = 0;
  setInterval(async () => {
    try {
      const done = await CH.settleDue();
      for (const d of done) log('⚖️  settled on chain', d.mint.slice(0, 6), d.sig.slice(0, 8));
    } catch (e) { warn('crank', e.message); }
    // ⛔ THE BALANCE HAS TO BE READ BEFORE SOMETHING IS STUCK, NOT AFTER.
    // This block used to `return` when nothing was stuck, so `crankBalance()` was only ever called
    // once a launch had ALREADY frozen — and `crank.sol` in /api/health, the whole point of which
    // was to be watched from outside, read `null` for ever in a healthy process. A warning that
    // arrives after the coin cannot be bought is a post-mortem, not a monitor. One balance read a
    // minute, cached for thirty seconds inside chain.mjs, buys the warning BEFORE the freeze.
    try {
      const stuck = E.listTokens({ status: 'fairopen', limit: 50 }).filter((t) => t.fairOpenEnds && t.fairOpenEnds <= Date.now());
      const bal = await CH.crankBalance();
      if (bal === null || bal >= 0.02 || Date.now() - crankWarnedAt <= 60_000) return;
      crankWarnedAt = Date.now();
      // A settle costs about 5000 lamports, so 0.02 SOL is roughly four thousand of them: far enough
      // ahead to be a warning rather than an outage, and the message says which it is.
      if (stuck.length) {
        warn('CRANK OUT OF SOL', `${CH.crankAddress() || '?'} holds ${bal.toFixed(6)} SOL —`,
          `${stuck.length} Fair Open(s) past their window cannot settle, so those coins CANNOT BE BOUGHT:`,
          stuck.map((t) => t.symbol).join(', '), '· fund the crank wallet to clear it');
      } else {
        warn('CRANK RUNNING LOW', `${CH.crankAddress() || '?'} holds ${bal.toFixed(6)} SOL,`,
          `about ${Math.floor((bal * 1e9) / 5000)} more settles · nothing is stuck yet · fund it before a Fair Open freezes`);
      }
    } catch { /* diagnosis must never break the crank */ }
  }, Number(process.env.CRANK_MS || 20000));
  // Background for the same reason as the pool sweep: the indexer polls constantly and nobody is
  // sitting in front of it waiting for an answer.
  CH.background(() => IX.start()).catch((e) => warn('indexer', e.message));
  // The burn figures take 15s upstream. Fetch them at boot so the first visitor sees numbers rather
  // than the empty state that stood in for them until now.
  RW.warm();
  // ⛔ AND THE PAIR LIST, for the same reason one layer along. The scan that discovers which quotes
  // LaunchLab can carry runs off the request path, so the FIRST caller after any restart is served
  // the three seeded pairs — which is precisely the broken state this replaced: ZCAT, SI, MASK and
  // ALLINU greyed out on the launch form. Measured, not guessed: the first /api/state after a
  // restart returned 3 pairs and the next returned 53. A window of seconds is still a window in
  // which somebody opens the launch form and sees the bug we just fixed.
  import('./lib/launchlab.mjs')
    .then((LL) => LL.llRefreshConfigs({ force: true }))
    .catch((e) => warn('launchlab', `boot config scan: ${e.message}`));
  setInterval(() => { while (IX.events.length) { const ev = IX.events.shift(); if (ev.type === 'trade') ev.who = nameOf(ev.wallet); broadcast(ev); } }, 250);
}
if (cfg.sim) { const sim = await import('./lib/sim.mjs'); await refreshPrices().catch(() => {}); await sim.seedIfEmpty(); sim.startSim(); }
if (!db.prepare("SELECT v FROM meta WHERE k='epoch_at'").get()) db.prepare("INSERT INTO meta(k,v) VALUES('epoch_at',?)").run(String(Date.now()));
server.on('error', (e) => { warn('listen', e.message); process.exit(1); }); // a bind failure must EXIT, not linger as a zombie still running cranks
server.listen(cfg.port, () => log(`🔥 ${cfg.brand} listening on :${cfg.port}  sim=${cfg.sim}  epoch=${cfg.epochMs / 1000}s  data=${cfg.dataDir}`));
