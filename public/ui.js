import { icon } from '/icons.js';
// Formatters + reusable components.
import { S, usdOf, quoteOf } from '/state.js';
export const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (w) => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');

/**
 * Copy to the clipboard, and tell the truth about whether it worked.
 *
 * ⛔ FIVE CALL SITES DID `navigator.clipboard?.writeText(x); toast('ok', 'Copied')` — fire the
 * promise, ignore it, and claim success unconditionally. writeText REJECTS whenever the document is
 * not focused, the page is not a secure context, or the permission is refused, and in every one of
 * those cases the user was told "Copied" while the clipboard still held whatever was in it before.
 *
 * On a launchpad that is not a cosmetic bug. The thing people copy most is a contract address, and
 * a confident "Copied" followed by pasting the PREVIOUS contents into a wallet is how somebody buys
 * the wrong token. The unhandled rejections showed up in the console the moment the page was
 * exercised without focus.
 *
 * So: await it, fall back to the legacy path for non-secure contexts (http:// over a LAN, which is
 * how the dev build is reached), and report what actually happened.
 */
/**
 * What to actually show someone when something threw.
 *
 * ⛔ A SERVER MESSAGE AND A JAVASCRIPT FAULT ARE NOT THE SAME KIND OF THING, and the UI was
 * printing both. `api()` throws `new Error(serverMessage)`, and those messages are written for
 * people — "Amount must be a positive number", "You already called $SYB" — so they pass straight
 * through. A TypeError is ours: measured on /points against a malformed response, the page rendered
 * "Cannot read properties of null (reading 'me')" to the user, which tells a trader nothing except
 * that we are broken.
 *
 * The distinction is the constructor, not the text, because the text is exactly what we cannot
 * trust. The real error still goes to the console, where it is of use to whoever is debugging.
 */
export function niceErr(e, fallback = 'Something went wrong there') {
  const m = String(e?.message || '').trim();
  // ⛔ THE NETWORK CHECK COMES FIRST, BECAUSE "Failed to fetch" IS ITSELF A TypeError. Ordered the
  // other way — which is how this was first written — a dropped connection fell into the generic
  // branch and read "Something went wrong there", hiding the one diagnosis the user can act on.
  if (/^failed to fetch$/i.test(m) || /networkerror/i.test(m) || /load failed/i.test(m)) {
    return 'Could not reach the server — check your connection';
  }
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) {
    console.error('internal error surfaced to the UI:', e);
    return fallback;
  }
  if (!m) return fallback;
  return m;
}

export async function copyText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(s); return true; }
  } catch { /* fall through to the legacy path rather than giving up */ }
  try {
    // execCommand is deprecated and still the only thing that works on an insecure origin.
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}
export function fmtNum(n, d) {
  if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n);
  if (Number.isInteger(n) && a < 1e4 && d == null) return n.toLocaleString();
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K'; if (a >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (d != null) return n.toFixed(d); if (a >= 100) return n.toFixed(1); if (a >= 1) return n.toFixed(2); if (a >= 0.01) return n.toFixed(4); if (a === 0) return '0'; return n.toPrecision(3);
}
export const fmtUsd = (n) => (n == null || !isFinite(n)) ? '—' : (Math.abs(n) < 0.01 && n !== 0 ? '<$0.01' : '$' + fmtNum(n));
export const fmtQ = (n, q) => `${fmtNum(n)} ${q}`;
export function fmtPrice(p) { // tiny prices with subscript zero-count: 0.0₆4109
  if (!(p > 0)) return '0'; if (p >= 1) return fmtNum(p); const s = p.toFixed(18); const m = /^0\.(0*)(\d+)/.exec(s); const z = m[1].length; if (z < 3) return p.toFixed(z + 4);
  const sub = String(z).split('').map((c) => '₀₁₂₃₄₅₆₇₈₉'[c]).join(''); return `0.0${sub}${m[2].slice(0, 4)}`;
}
export const pct = (x, d = 1) => (x == null || !isFinite(x)) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
export function ago(ts) { const s = Math.max(0, (Date.now() - ts) / 1000); if (s < 60) return `${Math.floor(s)}s`; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`; }
export function mmss(ms) { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60), r = s % 60; if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; }
export const av = (t, cls = '') => `<img class="av ${cls}" src="${h(t.image || '/brand/rex-glyph.png?v=2')}" alt="" loading="lazy" onerror="this.src='/brand/rex-glyph.png?v=2'">`;
/**
 * A quote asset, shown with its OWN artwork rather than a coloured dot.
 * A dot says "this is some token"; the logo says which one, and these coins have artwork precisely
 * so people recognise them. The dot stays as the fallback for an asset we hold no image for, so a
 * missing file degrades to the old behaviour instead of a gap.
 */
export const qlogo = (q) => {
  const a = quoteOf(q) || {};
  return a.logo ? `<img class="qdi" src="${h(a.logo)}" alt="" loading="lazy">`
                : `<i class="qd" style="background:${a.color || '#888'}"></i>`;
};
export const qchip = (q) => `<span class="chip">${qlogo(q)}${h(q)}</span>`;
export function badges(t, { history = true } = {}) {
  const b = [];
  if (t.status === 'fairopen') b.push(`<span class="chip fair">${icon('scales')}Fair Open live</span>`); else if (history && t.fairOpenSecs > 0) b.push(`<span class="chip fair">${icon('scales')}Fair Open</span>`);
  // The chip is the HOLDER bucket, not the total fee — "Pays 4%" on a 2/1/1 mix would claim the
  // dev's and the vault's legs are holder income.
  const hb = t.fees?.holderBps ?? t.taxBps;
  if (hb > 0) b.push(`<span class="chip conv">${icon('rex')}Pays ${(hb / 100).toFixed(hb % 100 ? 1 : 0)}%</span>`);
  if (t.status === 'graduated') b.push(`<span class="chip grad">${icon('cap')}Graduated</span>`);
  b.push(qchip(t.quote)); return b.join('');
}
export function spark(vals, w = 96, hh = 36) {
  if (!vals || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), r = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${hh - ((v - min) / r) * (hh - 4) - 2}`).join(' ');
  const upc = vals[vals.length - 1] >= vals[0]; const c = upc ? '#3dffa0' : '#ff4d6d';
  return `<svg class="spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><defs><linearGradient id="sg${upc ? 'u' : 'd'}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".35"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/><polygon points="0,${hh} ${pts} ${w},${hh}" fill="url(#sg${upc ? 'u' : 'd'})"/></svg>`;
}
export function ring(msLeft, msTotal, cls = '') {
  const r = 27, C = 2 * Math.PI * r, f = Math.max(0, Math.min(1, msLeft / Math.max(1, msTotal)));
  return `<div class="ring ${cls}" data-total="${msTotal}"><svg viewBox="0 0 64 64" width="100%" height="100%"><circle class="bg" cx="32" cy="32" r="${r}" fill="none" stroke-width="5"/><circle class="fg" cx="32" cy="32" r="${r}" fill="none" stroke-width="5" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - f)}"/></svg><div class="t">${mmss(msLeft)}</div></div>`;
}
export function tickRing(el, msLeft, msTotal) { const r = 27, C = 2 * Math.PI * r; const f = Math.max(0, Math.min(1, msLeft / Math.max(1, msTotal))); const fg = el.querySelector('.fg'); if (fg) fg.style.strokeDashoffset = C * (1 - f); const t = el.querySelector('.t'); if (t) t.textContent = mmss(msLeft); }
/**
 * A coin's own website and socials, as real anchors.
 *
 * ONE definition for the two surfaces that show them — the coin page wants them labelled, a board
 * card wants them as icons — because what has to stay identical between the two is not the shape
 * but the POLICY: where they open, and what a crawler is told about them.
 *
 * ⛔ nofollow AS WELL AS noopener. These are links a stranger typed into a launch form, rendered on
 * 60-odd coin pages of a real domain. noopener protects the tab; nofollow is the half that stops
 * the launch form being a link farm.
 *
 * ⛔ COMPACT IS NOT "THE SAME CHIP, SMALLER". A board card is one big link to the coin, so these
 * are the only things inside it that go somewhere else — they need a label for assistive tech and a
 * tap target, which a 24px glyph with no text does not have on its own. Both live on `.soc`.
 */
export const socialLinks = (t, { compact = false } = {}) => {
  const one = (href, ic, label) => (compact
    ? `<a class="soc" href="${h(href)}" target="_blank" rel="noopener nofollow" title="${label}" aria-label="${label}">${ic}</a>`
    : `<a class="btn sm" href="${h(href)}" target="_blank" rel="noopener nofollow">${ic}${label}</a>`);
  return [
    t.website ? one(t.website, icon('globe'), 'Website') : '',
    t.twitter ? one(t.twitter, '𝕏', compact ? 'Twitter' : ' Twitter') : '',
    t.telegram ? one(t.telegram, icon('send'), 'Telegram') : '',
  ].join('');
};
export const tier = (mult, label) => `<span class="tier m${mult >= 3 ? 3 : mult > 1 ? 2 : 1}">×${mult}${label ? ' ' + h(label) : ''}</span>`;
export function tokenCard(t, { animate = true } = {}) {
  const usd = usdOf(t.quote); const fo = t.status === 'fairopen';
  const socs = socialLinks(t, { compact: true });
  // ⛔ THE CARD CANNOT BE AN <a> ANY MORE, AND NOT FOR A STYLING REASON. It was one, and a coin's
  // socials have to be real anchors — but an <a> inside an <a> is not nesting, it is a PARSE
  // ERROR: the parser closes the outer anchor the moment it meets the inner one, so .kpi and the
  // curve bar would have been emitted as SIBLINGS of the card and laid out as their own grid
  // items. The card is a div with a stretched link over it, which keeps the whole surface
  // clickable (and middle-clickable, and copyable) while leaving room for links that go elsewhere.
  return `<div class="card ${animate ? 'in' : ''} ${!fo && t.spark && t.spark.length > 1 ? 'has-spark' : ''}" data-mint="${t.mint}">
    <a class="cardlink" href="/t/${t.mint}" data-link aria-label="${h(t.name)} $${h(t.symbol)}"></a>
    ${fo ? '' : spark(t.spark)}
    <div class="top">${av(t)}<div class="grow"><div class="nm"><span class="nmt" title="${h(t.name)}">${h(t.name)}</span><span class="sym">$${h(t.symbol)}</span></div><div class="by">by <span class="mono">${short(t.creator)}</span> · ${ago(t.createdAt)} ago${t.holders ? ` · ${t.holders} holders` : ''}</div></div></div>
    <div class="meta">${badges(t, { history: false })}${socs ? `<span class="socs">${socs}</span>` : ''}</div>
    ${fo ? `<div class="kpi"><div><div class="l">Window closes</div><div class="v gold" data-fo-count="${t.fairOpenEnds}">${mmss(t.fairOpenEnds - Date.now())}</div></div><div><div class="l">Committed</div><div class="v" data-fo-total>${fmtQ(t.fairOpenTotal, t.quote)}</div></div><div><div class="l">Bidders</div><div class="v" data-fo-bidders>${t.fairOpenBidders}</div></div></div>`
       : `<div class="kpi"><div><div class="l">Market cap</div><div class="v" data-mcap>${fmtUsd(t.mcapUsd)}</div></div><div><div class="l">5m</div><div class="v ${t.chg5m == null ? 'dim' : t.chg5m >= 0 ? 'up' : 'down'}" data-chg>${pct(t.chg5m)}</div></div><div><div class="l">Holder rewards</div><div class="v gold">${t.yieldPaid > 0 ? fmtUsd(t.yieldPaid * usd) : '—'}</div></div></div>`}
    <div class="prog ${t.status === 'graduated' ? 'grad' : ''}"><i style="width:${(t.progress * 100).toFixed(1)}%"></i></div>
    <div class="prog-l"><span>${t.status === 'graduated' ? 'On the AMM · LP burned' : `Curve ${(t.progress * 100).toFixed(1)}%`}</span><span>${t.status === 'graduated' ? `Liquidity ${fmtUsd(t.liquidity * usd)}` : `${fmtNum(t.raised)} / ${fmtNum(t.raiseTarget)} ${t.quote}`}</span></div>
  </div>`;
}
export function toast(kind, text, img) { const el = document.createElement('div'); el.className = `toast ${kind}`; el.innerHTML = `${img ? `<img src="${h(img)}">` : ''}<div>${text}</div>`; document.getElementById('toasts').appendChild(el); setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 300); }, 4200); }
export function modal(html) { const m = document.getElementById('modal'); m.innerHTML = `<div class="mbox">${html}</div>`; m.hidden = false; m.onclick = (e) => { if (e.target === m) m.hidden = true; }; return m; }
export const closeModal = () => { document.getElementById('modal').hidden = true; };
export function flashNum(el, dir) { if (!el) return; el.classList.remove('tick-up', 'tick-down'); void el.offsetWidth; el.classList.add(dir >= 0 ? 'tick-up' : 'tick-down'); }
export const walletLink = (w, name) => `<a class="w" href="/u/${w}" data-link title="${w}">${h(name || short(w))}</a>`;

// ---------- chart (lightweight-charts)
/**
 * The coin chart.
 *
 * It was a stock candlestick on a transparent background — correct, and completely silent. This is
 * the page people sit on while they decide, and nothing on it said whose site they were on or what
 * was happening to the thing they were watching.
 *
 * What is added is only ever tied to something REAL, because decoration on a price chart is how you
 * stop people trusting it:
 *   - a GREEN WASH under the price that deepens as the curve fills. REX's own colour, and it
 *     literally measures the thing the pad is about: how close this coin is to graduating.
 *   - the GRADUATION LINE, drawn where the curve ends. No general-purpose chart can show this
 *     because no other venue has it; it is the single most useful horizontal on a bonding curve.
 *   - a PULSE on the last price when a trade actually lands, not on a timer.
 * Reduced motion keeps every figure and drops the movement.
 */
export function mountChart(el, opts = {}) {
  const LW = window.LightweightCharts; if (!LW) { el.innerHTML = '<div class="empty">Chart library not loaded</div>'; return null; }
  const reduce = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const UP = '#3dffa0', DOWN = '#ff4d6d', REX = '#22c55e';

  const chart = LW.createChart(el, {
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8a8a96', fontFamily: 'JetBrains Mono', attributionLogo: false },
    grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.04)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,.08)' },
    timeScale: { borderColor: 'rgba(255,255,255,.08)', secondsVisible: false },
    crosshair: {
      mode: LW.CrosshairMode ? LW.CrosshairMode.Normal : 0,
      vertLine: { color: 'rgba(34,197,94,.45)', width: 1, style: 3, labelBackgroundColor: REX },
      horzLine: { color: 'rgba(34,197,94,.45)', width: 1, style: 3, labelBackgroundColor: REX },
    },
    ...(opts.chart || {}),
  });

  // The wash sits UNDER the candles and carries the brand colour. Its own price line is off: the
  // candles are the data, this is the mood.
  const area = chart.addAreaSeries({
    lineColor: 'rgba(34,197,94,.55)', lineWidth: 1,
    topColor: 'rgba(34,197,94,.22)', bottomColor: 'rgba(34,197,94,0)',
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  });
  const candles = chart.addCandlestickSeries({
    upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
    priceFormat: { type: 'price', precision: 9, minMove: 1e-9 },
    ...(opts.candles || {}),
  });
  const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: .82, bottom: 0 } });

  const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
  ro.observe(el);

  let gradLine = null;
  const api = {
    chart, candles, vol, area,
    /** Mirror the candle closes into the wash. One source of truth, two ways of reading it. */
    setData(rows) {
      candles.setData(rows);
      try { area.setData(rows.map((r) => ({ time: r.time, value: r.close }))); } catch {}
    },
    update(row) {
      candles.update(row);
      try { area.update({ time: row.time, value: row.close }); } catch {}
    },
    /** A price we know EXACTLY, marked on the scale. Never a derived or estimated one: a horizontal
     *  on a price chart is read as fact, and people trade against it. */
    setMarkPrice(price, title = '') {
      if (gradLine) { try { candles.removePriceLine(gradLine); } catch {} gradLine = null; }
      if (!(price > 0)) return;
      gradLine = candles.createPriceLine({
        price, color: 'rgba(255,194,77,.75)', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title,
      });
    },
    /** A trade landed. Flash the pane edge in the side's colour — once, briefly, never on a timer. */
    pulse(side = 'buy') {
      if (reduce) return;
      el.classList.remove('chart-pulse-buy', 'chart-pulse-sell');
      void el.offsetWidth;                                  // restart the animation
      el.classList.add(side === 'sell' ? 'chart-pulse-sell' : 'chart-pulse-buy');
    },
    destroy() { ro.disconnect(); chart.remove(); },
  };
  return api;
}

/**
 * Count a number up to its value once, on first paint.
 *
 * Motion with a job: a figure that lands rather than simply being there reads as a number that is
 * still moving, which is what "92,156 burned" is. It runs ONCE per element and never loops — a
 * permanently animating statistic is decoration, and decoration on a number is how you stop people
 * believing it. Respects reduced-motion by just printing the value.
 */
export function tickUp(root = document, ms = 900) {
  const reduce = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  for (const el of root.querySelectorAll('.ticker[data-to]')) {
    if (el.dataset.done) continue;
    el.dataset.done = '1';
    const to = Number(el.dataset.to) || 0, suffix = el.dataset.suffix || '';
    // Write the REAL value first, always. requestAnimationFrame does not fire in a hidden or
    // throttled tab, so an animation that starts at zero and waits for a frame can leave the number
    // reading 0 indefinitely — which on a burn total is not a missing animation, it is a lie.
    el.textContent = fmtNum(to) + suffix;
    if (reduce || !(to > 0) || document.hidden) continue;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      // Ease out: fast at first, settling at the end, so the eye lands on the real figure.
      el.textContent = fmtNum(to * (1 - Math.pow(1 - k, 3))) + suffix;
      if (k < 1) requestAnimationFrame(step); else el.textContent = fmtNum(to) + suffix;
    };
    requestAnimationFrame(step);
  }
}
