// Dynamic share cards. A link to a token posted anywhere unfurls with its live market cap, what it
// has paid holders, and the fee split — so the post carries the pitch instead of a bare URL.
//
// Rendered with pureimage (pure JS, no native build) so it works identically on a laptop and in the
// Alpine container. Cards are cached on disk and regenerated when the numbers move, because a social
// crawler will hit the same URL many times and the figures only matter to one decimal.
import fs from 'node:fs';
import path from 'node:path';
import * as PImage from 'pureimage';
import { cfg } from './config.mjs';
import { usdOf } from './prices.mjs';

const FONT_DIR = path.join(process.cwd(), 'public/brand/fonts');
const CACHE = path.join(cfg.dataDir, 'og');
fs.mkdirSync(CACHE, { recursive: true });

let fontsReady = null;
function loadFonts() {
  if (fontsReady) return fontsReady;
  // Inter, SIL Open Font License — see public/brand/fonts/LICENSE-Inter.txt
  PImage.registerFont(path.join(FONT_DIR, 'Inter-Bold.ttf'), 'OGBold').loadSync();
  PImage.registerFont(path.join(FONT_DIR, 'Inter-Regular.ttf'), 'OGRegular').loadSync();
  fontsReady = true;
  return fontsReady;
}

const W = 1200, H = 630;
const money = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K'
  : '$' + (n || 0).toFixed(2);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

/**
 * The card's numbers, derived from a public token. Also the cache key: when none of these change,
 * the cached PNG is still correct however many times a crawler asks for it.
 */
export function cardState(t) {
  const usd = usdOf(t.quote) || 0;
  const fees = t.fees || {};
  return {
    symbol: t.symbol, name: t.name, quote: t.quote, image: t.image,
    mcap: Math.round((t.mcapUsd || 0)),
    paid: Math.round((t.yieldPaid || 0) * usd * 100) / 100,
    holders: t.holders || 0,
    holderBps: fees.holderBps || 0, totalBps: fees.totalBps || 0,
    share: t.social?.refShareOfTradeBps || 0,
    status: t.status,
  };
}
const keyOf = (s) => Buffer.from(JSON.stringify(s)).toString('base64url').slice(0, 48);

/** Render (or reuse) the card for a token. Returns an absolute path to a PNG. */
export async function ogCard(t) {
  loadFonts();
  const s = cardState(t);
  const file = path.join(CACHE, `${t.mint}-${keyOf(s)}.png`);
  if (fs.existsSync(file)) return file;

  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');

  // backdrop: near-black with a green wash behind the headline, matching the site
  ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(34,197,94,0.10)'; ctx.fillRect(0, 0, W, 300);
  ctx.fillStyle = '#22c55e'; ctx.fillRect(0, 0, W, 6);

  // wordmark
  ctx.font = "28pt 'OGBold'"; ctx.fillStyle = '#22c55e';
  ctx.fillText('REX Chain', 64, 92);
  ctx.font = "17pt 'OGRegular'"; ctx.fillStyle = '#7c8794';
  ctx.fillText('Launch. Build. Trade. Discover. Grow.', 64, 126);

  // the coin's own artwork, if we host it
  let textX = 64;
  if (s.image && s.image.startsWith('/img/')) {
    const p = path.join(cfg.dataDir, s.image.replace(/^\//, ''));
    try {
      if (fs.existsSync(p)) {
        const art = await PImage.decodePNGFromStream(fs.createReadStream(p)).catch(() => null)
          || await PImage.decodeJPEGFromStream(fs.createReadStream(p)).catch(() => null);
        if (art) {
          ctx.drawImage(art, 0, 0, art.width, art.height, 64, 196, 168, 168);
          textX = 264;
        }
      }
    } catch { /* a card without the artwork is still a good card */ }
  }

  // ticker and name
  ctx.font = "54pt 'OGBold'"; ctx.fillStyle = '#ffffff';
  ctx.fillText('$' + String(s.symbol || '').slice(0, 10), textX, 262);
  ctx.font = "22pt 'OGRegular'"; ctx.fillStyle = '#9aa4b2';
  ctx.fillText(String(s.name || '').slice(0, 34), textX, 302);

  // the three numbers that matter
  const stats = [
    ['Market cap', money(s.mcap)],
    ['Holder rewards', money(s.paid)],
    ['Holders', String(s.holders)],
  ];
  stats.forEach(([label, value], i) => {
    const x = 64 + i * 364;
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; roundRect(ctx, x, 392, 336, 118, 16); ctx.fill();
    ctx.font = "15pt 'OGRegular'"; ctx.fillStyle = '#7c8794'; ctx.fillText(label.toUpperCase(), x + 24, 430);
    ctx.font = "34pt 'OGBold'"; ctx.fillStyle = i === 1 ? '#9dff8f' : '#ffffff';
    ctx.fillText(value, x + 24, 482);
  });

  // the pitch line
  ctx.font = "19pt 'OGRegular'"; ctx.fillStyle = '#9aa4b2';
  const line = s.holderBps
    ? `${(s.holderBps / 100).toFixed(1)}% of every swap to holders, in ${s.quote} — a send pays nothing`
    : 'Sealed Fair Open — one clearing price, nobody fills block zero';
  ctx.fillText(line, 64, 566);
  if (s.share > 0) {
    ctx.fillStyle = '#22c55e';
    ctx.fillText(`Share & earn ${(s.share / 100).toFixed(2)}%`, 64, 598);
  }

  await PImage.encodePNGToStream(img, fs.createWriteStream(file));
  // keep only the newest card per mint
  for (const f of fs.readdirSync(CACHE)) {
    if (f.startsWith(t.mint + '-') && !f.endsWith(path.basename(file))) {
      try { fs.unlinkSync(path.join(CACHE, f)); } catch {}
    }
  }
  return file;
}

/**
 * A generic stats card, for routes that are a BOARD rather than a coin — /pairs today.
 *
 * Same frame as the token card on purpose: the two unfurl side by side in a chat, and a shared
 * silhouette is what makes the second one read as "the same place" rather than as a different site.
 *
 * `key` is the cache identity. It must contain every number drawn, or a card goes stale the moment
 * the board moves and the preview starts advertising figures that are no longer true — which is
 * worse than no card, because it looks authoritative.
 */
export async function statsCard({ key, title, subtitle, stats = [], line = '' }) {
  loadFonts();
  const file = path.join(CACHE, `board-${key}-${keyOf({ title, subtitle, stats, line })}.png`);
  if (fs.existsSync(file)) return file;

  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');
  ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(34,197,94,0.10)'; ctx.fillRect(0, 0, W, 300);
  ctx.fillStyle = '#22c55e'; ctx.fillRect(0, 0, W, 6);

  ctx.font = "28pt 'OGBold'"; ctx.fillStyle = '#22c55e';
  ctx.fillText('REX Chain', 64, 92);
  ctx.font = "17pt 'OGRegular'"; ctx.fillStyle = '#7c8794';
  ctx.fillText('Launch. Build. Trade. Discover. Grow.', 64, 126);

  ctx.font = "54pt 'OGBold'"; ctx.fillStyle = '#ffffff';
  ctx.fillText(String(title).slice(0, 22), 64, 262);
  ctx.font = "22pt 'OGRegular'"; ctx.fillStyle = '#9aa4b2';
  ctx.fillText(String(subtitle).slice(0, 58), 64, 302);

  // Up to four tiles across the same 1072px the token card's three occupy, so the grid lines up.
  const n = Math.min(stats.length, 4) || 1;
  const gap = 16, tw = (1072 - gap * (n - 1)) / n;
  stats.slice(0, 4).forEach(([label, value], i) => {
    const x = 64 + i * (tw + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; roundRect(ctx, x, 392, tw, 118, 16); ctx.fill();
    ctx.font = "13pt 'OGRegular'"; ctx.fillStyle = '#7c8794';
    ctx.fillText(String(label).toUpperCase().slice(0, 22), x + 20, 430);
    ctx.font = `${n > 3 ? 27 : 34}pt 'OGBold'`; ctx.fillStyle = i === 2 ? '#9dff8f' : '#ffffff';
    ctx.fillText(String(value).slice(0, 12), x + 20, 482);
  });

  if (line) { ctx.font = "19pt 'OGRegular'"; ctx.fillStyle = '#9aa4b2'; ctx.fillText(String(line).slice(0, 96), 64, 566); }

  await PImage.encodePNGToStream(img, fs.createWriteStream(file));
  for (const f of fs.readdirSync(CACHE)) {
    if (f.startsWith(`board-${key}-`) && f !== path.basename(file)) {
      try { fs.unlinkSync(path.join(CACHE, f)); } catch {}
    }
  }
  return file;
}
