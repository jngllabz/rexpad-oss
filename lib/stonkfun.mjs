// Real token data from StonkFun's public API — names, tickers, PFPs, links, creators and market state.
// Used by the SIM seed so the demo market is populated with real coins, not placeholders.
import fs from 'node:fs';
import path from 'node:path';
import { cfg, log, warn } from './config.mjs';
import { QUOTES } from './prices.mjs';

const BASE = 'https://www.stonkfun.xyz';
const H = { 'user-agent': 'Mozilla/5.0 (compatible; FORGE/0.1; +demo seed)' };
const QUOTE_BY_MINT = Object.fromEntries(Object.values(QUOTES).map((q) => [q.mint, q.symbol]));

export async function fetchTokens(params = {}) {
  const u = new URL(BASE + '/api/public/v1/tokens');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`stonkfun ${r.status}`);
  const j = await r.json();
  return j.data?.tokens || [];
}
export function mapToken(t) {
  const quote = QUOTE_BY_MINT[t.quote?.mint]; if (!quote) return null;
  const symbol = String(t.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const name = String(t.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);
  if (symbol.length < 2 || name.length < 2 || !t.imageUrl) return null;
  const m = t.market || {};
  return {
    sfMint: t.mint, name, symbol, quote, creator: t.creator, imageUrl: t.imageUrl.startsWith('http') ? t.imageUrl : BASE + t.imageUrl,
    website: t.links?.website || null, twitter: t.links?.twitter || null, telegram: t.links?.telegram || null,
    // A legal mix off the spec's own table, so the seeded market shows the range rather than one
    // setting: a reward coin relaunches as the "full engine" 2/1/1, everything else as "light" 1/1/1.
    fees: t.mode === 'reward' ? { holderBps: 200, creatorBps: 100, vaultBps: 100, burnBps: 0 }
                              : { holderBps: 100, creatorBps: 100, vaultBps: 100, burnBps: 100 },
    metadataUri: t.metadataUri || null,
    real: { mcapUsd: m.marketCapUsd || 0, vol24Usd: m.volume24hUsd || 0, progress: t.graduationProgress || 0, status: t.status, createdAt: Date.parse(t.createdAt) || Date.now() },
  };
}
export async function downloadImage(tok) {
  const file = `sf-${tok.sfMint}`;
  try {
    const r = await fetch(tok.imageUrl, { headers: H, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(String(r.status));
    const ct = r.headers.get('content-type') || ''; const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : ct.includes('svg') ? 'svg' : 'jpg';
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 100) throw new Error('empty');
    fs.writeFileSync(path.join(cfg.dataDir, 'img', `${file}.${ext}`), buf);
    return `/img/${file}.${ext}`;
  } catch (e) { warn('image download failed for', tok.symbol, e.message, '— hotlinking'); return tok.imageUrl; }
}
export async function fetchDescription(tok) {
  if (!tok.metadataUri) return '';
  try { const r = await fetch(tok.metadataUri, { headers: H, signal: AbortSignal.timeout(5000) }); const j = await r.json(); return String(j.description || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 600); } catch { return ''; }
}
async function hydrate(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 8) {
    const chunk = list.slice(i, i + 8);
    const done = await Promise.all(chunk.map(async (t) => ({ ...t, image: await downloadImage(t), description: await fetchDescription(t) })));
    out.push(...done);
  }
  return out;
}
const dedupe = (arr) => { const seen = new Set(); return arr.filter((t) => { const k = t.symbol + '|' + t.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };

// Roster for the seed: the biggest real coins on each of our quotes (by real market cap), hydrated with local PFPs.
// Per quote: the biggest graduated coins + the biggest coins still on the curve, so the grid shows both.
export async function loadRoster({ gp = [6, 4], sol = [4, 3], usdc = [2, 1] } = {}) {
  const want = [[QUOTES.GP.mint, gp], [QUOTES.SOL.mint, sol], [QUOTES.USDC.mint, usdc]];
  let all = [];
  for (const [mint, [nGrad, nCurve]] of want) {
    try {
      const page = (await fetchTokens({ quoteMint: mint, pageSize: 100 })).map(mapToken).filter(Boolean).sort((a, b) => b.real.mcapUsd - a.real.mcapUsd);
      all.push(...page.filter((t) => t.real.status === 'graduated').slice(0, nGrad), ...page.filter((t) => t.real.status !== 'graduated').slice(0, nCurve));
    } catch (e) { warn('roster fetch failed', mint.slice(0, 6), e.message); }
  }
  all = dedupe(all);
  log('📡 stonkfun roster:', all.map((t) => `${t.symbol}/${t.quote}`).join(' '));
  return hydrate(all);
}
// Newest real launches — the live sim launches these on FORGE one at a time.
export async function loadNewest(exclude = new Set(), n = 12) {
  const list = (await fetchTokens({ sort: 'newest', pageSize: 100 })).map(mapToken).filter((t) => t && !exclude.has(t.symbol) && !exclude.has(t.sfMint)).slice(0, n);
  return hydrate(dedupe(list));
}
