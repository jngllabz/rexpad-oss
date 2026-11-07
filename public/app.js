import { S, bus, api, loadState, connectWs, connectWallet, signOut, demoWallet, usdOf, watchWallet, restorePrivy } from '/state.js';
import { h, short, niceErr, fmtNum, fmtUsd, mmss, toast, av, fmtQ, modal, closeModal, copyText} from '/ui.js';
import { icon } from '/icons.js';
import { burst, celebrate, pulse, flash } from '/fx.js';
import * as P from '/pages.js';
import * as CHAIN from '/chain.js';
import { LANGS, getLang, setLang, startI18n } from '/i18n.js';

const app = document.getElementById('app');
let teardown = null;
const routes = [
  [/^\/$/, () => P.home(app)],
  [/^\/fair-opens$/, () => P.home(app, { fairOnly: true })],
  [/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, (m) => P.token(app, m[1])],
  // ⛔ ANY LINK CARRYING A MINT SHOULD LAND ON THAT COIN, NOT ON "Nothing here to eat".
  // External terminals link to a launchpad's coin page using whatever path shape they assume —
  // /token/<mint>, /coin/<mint>, or the bare mint — and ours is /t/<mint>. Ale reported the Rex
  // website link on fomo landing on our 404. A mint address is unmistakable (32-44 base58, and no
  // real route looks like one), so accept the lot and correct the URL in place.
  [/^\/(?:token|coin|c|t)\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/, (m) => { history.replaceState({}, '', '/t/' + m[1]); return P.token(app, m[1]); }],
  [/^\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/, (m) => { history.replaceState({}, '', '/t/' + m[1]); return P.token(app, m[1]); }],
  // /design and /press are the names people actually type looking for a brand kit; all three land
  // on the same page rather than on "Nothing here to eat", for the same reason the mint shapes above
  // are all accepted.
  [/^\/(?:brand|design|press)$/, () => P.brand(app)],
  [/^\/basket$/, () => P.basket(app)],
  [/^\/create$/, () => P.create(app)],
  [/^\/me$/, () => P.profile(app)],
  [/^\/welcome$/, () => P.welcome(app, { onDone: () => { history.replaceState({}, '', '/me'); route(); } })],
  [/^\/u\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, (m) => P.profile(app, m[1])],
  [/^\/pairs$/, () => P.pairs(app)],
  [/^\/leaderboard$/, () => P.leaderboard(app)],
  [/^\/points$/, () => P.points(app)],
  [/^\/build$/, () => P.build(app)],
  [/^\/growth$/, () => P.growth(app)],
  [/^\/admin$/, () => P.admin(app)],
  [/^\/creator$/, () => P.creator(app)],
  [/^\/earnings$/, () => P.earnings(app)],
  [/^\/rewards$/, () => P.rewards(app)],
  [/^\/learn$/, () => P.learn(app)],
  [/^\/swap$/, () => P.swap(app)],
  [/^\/liquidity$/, () => P.liquidity(app)],
];
/**
 * ⛔ A PAGE THAT THROWS WHILE LOADING MUST NOT LEAVE A BLANK SCREEN.
 *
 * Every page here does its own fetching, and a page that awaits before it renders anything has
 * nothing on screen if that await rejects. Measured: with one API call failing, /growth rendered
 * NOTHING AT ALL — no header, no message, no retry — and logged an unhandled rejection nobody sees.
 * From the outside that is indistinguishable from the site being down, and the honest state is "one
 * request failed", which is a very different thing and usually fixes itself.
 *
 * Catching it here covers every page at once, including the ones written after this, which is worth
 * more than eleven individual try/catches that the twelfth page will forget.
 */
async function route() {
  if (teardown) { try { teardown(); } catch {} teardown = null; }
  const p = location.pathname;
  for (const [re, fn] of routes) {
    const m = re.exec(p);
    if (!m) continue;
    window.scrollTo(0, 0);
    try { teardown = await fn(m); }
    catch (e) {
      teardown = null;
      console.error('page failed', p, e);
      app.innerHTML = `<div class="fade" style="text-align:center;padding:70px 20px">
        <div style="font-size:30px;margin-bottom:6px">${icon('warn')}</div>
        <h1 style="font-size:26px">This page did not load</h1>
        <p class="muted" style="margin:10px auto 20px;max-width:420px;line-height:1.5">Something it needed did not come back${e ? ` — <span class="dim">${h(niceErr(e, ''))}</span>` : ''}. It is usually a hiccup rather than anything being wrong with your wallet or your coins.</p>
        <button class="btn cta" id="retryPage"><span>Try again</span></button></div>`;
      document.getElementById('retryPage').onclick = () => route();
    }
    markNav(p); markMobile(p);
    return;
  }
  app.innerHTML = `<div class="fade" style="text-align:center;padding:80px 20px"><div class="ic-404">${icon('rex')}</div><h1 style="font-size:34px;margin-top:10px">Nothing here to eat</h1><p class="muted" style="margin:10px 0 22px">That page doesn't exist.</p><a class="btn cta" href="/" data-link><span>Back to Discover</span></a></div>`;
}
// The feedback box is reachable from every page — a report is worth most from whoever just hit the
// thing, not from whoever found their way to a form later.
document.getElementById('fbOpen')?.addEventListener('click', (e) => { e.preventDefault(); P.feedbackModal('rating'); });

function markNav(p) { const k = p === '/' ? 'home' : p.startsWith('/fair') ? 'fair' : p.startsWith('/swap') ? 'swap' : p.startsWith('/liquidity') ? 'lp' : p.startsWith('/build') ? 'build' : p.startsWith('/growth') ? 'growth' : p.startsWith('/points') ? 'points' : p.startsWith('/leader') ? 'board' : p.startsWith('/rewards') ? 'rewards' : p.startsWith('/learn') ? 'learn' : ''; document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === k)); }
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey) return; const href = a.getAttribute('href'); if (!href || !href.startsWith('/')) return; e.preventDefault(); if (href !== location.pathname) { history.pushState({}, '', href); route(); } });
addEventListener('popstate', route);

// ---------- nav: wallet, search, epoch chip
const wb = document.getElementById('walletBtn');
function renderWallet() {
  document.getElementById('wmenu')?.remove();
  if (S.me) { const sol = S.me.balances?.SOL || 0; wb.classList.add('on'); wb.innerHTML = `<span class="mono" style="font-size:12px">${fmtNum(sol)} SOL</span><span>·</span><span>${h(S.me.name)}</span><svg width="12" height="12" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.5" d="m6 9 6 6 6-6"/></svg>`; wb.oncontextmenu = null;
    wb.onclick = (e) => { e.stopPropagation(); let m = document.getElementById('wmenu'); if (m) return m.remove();
      m = document.createElement('div'); m.id = 'wmenu'; m.className = 'wmenu'; m.innerHTML = `<div class="wm-head"><b>${h(S.me.name)}</b><span class="mono dim">${short(S.me.wallet)}</span></div><button data-a="me">Portfolio</button><button data-a="copy">Copy address</button><button data-a="out" class="danger">Sign out</button>`;
      document.body.appendChild(m); const r = wb.getBoundingClientRect(); m.style.top = r.bottom + 8 + 'px'; m.style.right = Math.max(8, innerWidth - r.right) + 'px';
      m.onclick = async (ev) => { const a = ev.target.closest('button')?.dataset.a; m.remove(); if (a === 'me') { history.pushState({}, '', '/me'); route(); } if (a === 'copy') { copyText(S.me.wallet).then((ok) => toast(ok ? 'ok' : 'err', ok ? 'Address copied' : 'Could not copy — select the address and copy it by hand')); } if (a === 'out') { await signOut(); toast('ok', 'Signed out'); } };
      const away = (ev) => { if (!m.isConnected) return document.removeEventListener('pointerdown', away); if (!m.contains(ev.target) && !wb.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', away); } }; document.addEventListener('pointerdown', away); }; }
  else { wb.classList.remove('on'); wb.textContent = 'Connect wallet'; wb.onclick = connectWallet; }
}
bus.on('auth', renderWallet);
// First connect, once. `setup` is false only for a wallet that has never saved a profile, so this
// fires for a newcomer and never again — and never while they are mid-task on another page, which
// is why it is skipped anywhere a redirect would throw away what they were doing.
const MID_TASK = /^\/(create|build|swap)/;
bus.on('auth', (me) => {
  if (!me || me.profile?.setup || MID_TASK.test(location.pathname) || location.pathname === '/welcome') return;
  history.pushState({}, '', '/welcome'); route();
});
const q = document.getElementById('q'); let qt;
q.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { if (location.pathname !== '/') { history.pushState({}, '', '/'); route().then(() => bus.emit('search', q.value.trim())); } else bus.emit('search', q.value.trim()); }, 250); });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !e.target.matches('input,textarea')) { e.preventDefault(); q.focus(); } if (e.key === 'Escape') { q.blur(); document.getElementById('modal').hidden = true; document.getElementById('wmenu')?.remove(); } });
setInterval(() => { const el = document.getElementById('epochIn'); if (S.nextEpochAt) el.textContent = mmss(S.nextEpochAt - Date.now()); }, 1000);
document.getElementById('epochChip').onclick = () => { history.pushState({}, '', '/learn'); route(); };

// ---------- the $REX contract address, one click to copy
// Elio: "add the REX ca somewhere for people easy buy on the REXCHAIN pad. One click copy the ca."
function renderCa() {
  const el = document.getElementById('rexCa'); const ca = S.gate?.rexCa;
  if (!el || !ca) return;
  // Full address on a desktop width, a short form on a phone — the whole strip has to stay on one
  // line there or it wraps into two and pushes the page down. Copy always carries the full thing.
  const short = `${ca.slice(0, 6)}…${ca.slice(-6)}`;
  el.innerHTML = `<b>$REX</b><span class="addr" title="${h(ca)}"><span class="full">${h(ca)}</span><span class="shortca">${h(short)}</span></span>`
    + `<button id="caCopy">Copy</button>`
    + `<a class="buy" href="https://jup.ag/swap/SOL-${h(ca)}" target="_blank" rel="noopener">Buy $REX</a>`;
  el.hidden = false;
  document.getElementById('caCopy').onclick = async (e) => {
    const b = e.currentTarget;
    try { if (!await copyText(ca)) throw new Error('copy refused'); }
    catch { const t = document.createElement('textarea'); t.value = ca; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    b.textContent = 'Copied'; b.classList.add('done');
    setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
  };
}

// ---------- language
function renderLangSwitch() {
  const el = document.getElementById('langsw'); if (!el) return;
  el.innerHTML = LANGS.map(([code, label]) => `<button data-lang="${code}" class="${code === getLang() ? 'on' : ''}">${label}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => b.onclick = () => { if (b.dataset.lang !== getLang()) setLang(b.dataset.lang); });
}

// ---------- devnet banner + test-token faucet
function renderChainBar() {
  document.getElementById('chainbar')?.remove();
  const c = S.chain; if (!c || c.cluster === 'mainnet') return;
  const el = document.createElement('div'); el.id = 'chainbar';
  el.innerHTML = `<span class="cb-tag">${h(c.cluster).toUpperCase()}</span>
    <span>Test network — every coin is a real SPL mint and every trade a real transaction, but the money is worth nothing. You sign in your own wallet and it settles on ${h(c.cluster)}.</span>
    ${c.faucet ? '<button id="cbFaucet">Get test funds</button>' : ''}
    <a href="https://faucet.solana.com" target="_blank" rel="noopener">More ${h(c.cluster)} SOL</a>`;
  document.body.appendChild(el);
  const f = document.getElementById('cbFaucet');
  if (f) f.onclick = async () => {
    if (!S.me) return connectWallet();
    f.disabled = true; f.textContent = 'Sending…';
    try {
      // Hands out whichever quote the launch screen currently has selected, so a META or xStock pair
      // can be bought as well as created. Falls back to the default when nothing is chosen.
      const r = await api('/api/chain/faucet', { wallet: S.me.wallet, symbol: window.__rexQuote || '' });
      // The SOL half only goes out when the wallet is short, so only mention it when it happened.
      toast('ok', `Sent <b>${fmtNum(r.amount)} test $${h(r.symbol || 'REX')}</b>${r.sol ? ` and <b>${r.sol.toFixed(3)} SOL</b> for fees` : ''} to your wallet`);
    } catch (e) { toast('err', niceErr(e)); }
    f.disabled = false; f.textContent = 'Get test funds';
  };
}
// ---------- featured coins
// A short row of MAINNET coins, led by REX itself. This site may be running on devnet, so every
// entry says so plainly — next to a book of test launches, an unlabelled market cap in real dollars
// is the most misleading thing on the page.
//
// Clicking one opens its chart and a swap. These coins are not in our book, so there are no candles
// of our own to draw: the chart is Birdeye's, keyed on the mint, and the swap is the same Jupiter
// route the /swap page uses. Both settle on mainnet whatever network the rest of the site is on.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const fbUsd = (n) => (n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Number(n || 0).toFixed(2));

let featList = [];
async function renderFeatured() {
  const bar = document.getElementById('featbar'); if (!bar) return;
  // The configured mainnet coins lead; every live launch follows, newest first. A bar that showed a
  // fixed pair while the pad filled up was advertising the wrong thing — Ale asked for this the
  // moment there were more than two coins to show.
  try {
    const r = await api('/api/featured');
    const pinned = r.list || (r.featured ? [r.featured] : []);
    const seen = new Set(pinned.map((f) => f.mint));
    featList = [...pinned, ...(r.launches || []).filter((f) => !seen.has(f.mint))];
  } catch { featList = []; }
  if (!featList.length) { bar.hidden = true; return; }     // no slot, no bar — never a broken one
  const offnet = S.chain?.cluster !== 'mainnet';
  bar.innerHTML = `<span class="fb-tag">Featured</span>
    <div class="fb-row">${featList.map((f, i) => {
      const up = f.change24 >= 0;
      return `<button class="fb-item${f.isRex ? ' rex' : ''}${f.own ? ' own' : ''}" data-i="${i}" title="${f.own ? `Open $${h(f.symbol)}` : `Open the ${h(f.symbol)} chart and swap`}">
        ${f.image ? `<img class="fb-img" src="${h(f.image)}" alt="" loading="lazy">` : ''}
        <span class="fb-txt">
          <span class="fb-top"><b class="fb-sym">$${h(f.symbol)}</b>${f.quote ? `<span class="fb-pair">/ ${h(f.quote)}</span>` : ''}
            <span class="fb-ch ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(f.change24).toFixed(1)}%</span></span>
          <span class="fb-bot"><span class="fb-mc">${fbUsd(f.mcapUsd)}<small>mcap</small></span>
            <span class="fb-vol">${fbUsd(f.vol24Usd)}<small>24h vol</small></span></span>
        </span></button>`;
    }).join('')}</div>
    ${offnet ? '<span class="fb-note">real coins on mainnet — not test launches</span>' : ''}`;
  bar.querySelectorAll('.fb-item').forEach((b) => b.onclick = () => {
    const f = featList[Number(b.dataset.i)];
    // ⛔ Our own coins have a real page with our own chart, trade tape and buy box. The Birdeye
    // sheet exists only because an EXTERNAL coin is not in our book; sending a launch there would
    // hide everything the pad actually knows about it.
    if (f?.own) { history.pushState({}, '', `/t/${f.mint}`); dispatchEvent(new PopStateEvent('popstate')); return; }
    openFeatured(f);
  });
  // A horizontal rail needs to say it is one. CSS cannot ask "am I overflowing?", so the fade that
  // means "there is more this way" is toggled here, and only when it is true.
  const row = bar.querySelector('.fb-row');
  if (row) {
    const sync = () => {
      bar.classList.toggle('scrolls', row.scrollWidth > row.clientWidth + 4);
      bar.classList.toggle('at-end', row.scrollLeft + row.clientWidth >= row.scrollWidth - 4);
    };
    row.onscroll = sync;
    // A trackpad's vertical gesture is how most people will try to move a horizontal rail.
    row.onwheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (row.scrollWidth <= row.clientWidth) return;
      e.preventDefault(); row.scrollLeft += e.deltaY;
    };
    sync(); addEventListener('resize', sync, { passive: true });
  }
  // Attached, not an onerror= attribute: our own script-src blocks inline handlers, so the markup
  // version silently never fires and a dead CDN leaves a broken-image glyph in the bar forever.
  bar.querySelectorAll('.fb-img').forEach((i) => i.onerror = () => i.remove());
  bar.hidden = false;
}

// The chart + swap sheet. Everything in it is about somebody else's liquidity, so it states where
// each number comes from rather than presenting third-party data as our own.
function openFeatured(f) {
  if (!f) return;
  const up = f.change24 >= 0;
  const m = modal(`<div class="fbhead">
      ${f.image ? `<img class="fbh-img" src="${h(f.image)}" alt="">` : ''}
      <div><h3>$${h(f.symbol)}${f.quote ? `<span class="fb-pair"> / ${h(f.quote)}</span>` : ''}</h3>
        <p class="muted">${h(f.name || '')} · ${fbUsd(f.mcapUsd)} mcap · <span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(f.change24).toFixed(1)}%</span> 24h</p></div>
      <button class="btn ghost sm" id="fbX">Close</button>
    </div>
    <div class="fbchart"><iframe src="https://birdeye.so/tv-widget/${encodeURIComponent(f.mint)}?chain=solana&viewMode=pair&chartInterval=15&chartType=CANDLE&theme=dark&chartLeftToolbar=hide"
      title="${h(f.symbol)} chart" loading="lazy" referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe></div>
    <div class="fbswap">
      <div class="row between"><span class="l">Buy ${h(f.symbol)} with SOL</span><span class="dim" id="fbRate"></span></div>
      <div class="row" style="margin-top:8px"><input id="fbAmt" inputmode="decimal" placeholder="0.0"><span class="fbunit">SOL</span></div>
      <div class="fbquick">${['0.1', '0.25', '0.5', '1'].map((x) => `<button data-a="${x}">${x}</button>`).join('')}</div>
      <div class="dim" id="fbOut" style="margin-top:8px;min-height:18px"></div>
      <button class="btn cta lg" id="fbGo" style="width:100%;margin-top:10px" disabled><span>Enter an amount</span></button>
      <div class="hint" style="margin-top:9px;text-align:center">Routed by Jupiter, settles on <b>Solana mainnet</b>. Your wallet signs; nothing custodial.
        Chart by Birdeye · <a href="https://dexscreener.com/solana/${encodeURIComponent(f.pool || f.mint)}" target="_blank" rel="noopener">DexScreener ↗</a></div>
    </div>`);
  m.querySelector('.mbox').classList.add('fbmodal');
  m.querySelector('#fbX').onclick = closeModal;

  // Decimals come from Jupiter, not a guess: showing an output amount off by a factor of 1000
  // because we assumed six places is exactly the kind of number somebody trades on.
  let dec = null, q = null, amt = '', busy = false, timer = null;
  // AWAITED, not raced. Firing this off and reading `dec` whenever the quote happened to land meant
  // a fast quote beat a slow lookup and the sheet said "Route found." with no amount — the one
  // number somebody opened it for. It is one request, kept as a promise so every quote waits on the
  // same one rather than asking again.
  const decs = api('/api/jup/token', { mint: f.mint })
    .then((r) => { dec = r.token?.decimals ?? null; return dec; }).catch(() => null);

  const out = m.querySelector('#fbOut'), go = m.querySelector('#fbGo'), rate = m.querySelector('#fbRate');
  const setGo = (txt, on) => { go.innerHTML = `<span>${txt}</span>`; go.disabled = !on; };
  const quote = async () => {
    q = null; const n = Number(amt);
    if (!(n > 0)) { out.textContent = ''; setGo('Enter an amount', false); return; }
    const base = Math.floor(n * 1e9);                      // SOL has nine places
    out.textContent = 'Quoting…'; setGo('Quoting…', false);
    try {
      await decs;
      q = await api('/api/jup/quote', { inputMint: SOL_MINT, outputMint: f.mint, amount: base, slippageBps: 100 });
      const o = dec == null ? null : Number(q.quote.outAmount) / 10 ** dec;
      // Impact and fee are shown, not buried. These coins sit in pools a few tens of thousands deep,
      // where a single SOL moves the price — and REX's own cut is not something to find out about
      // after signing. The full /swap page states both; a shortcut that quietly did not would be the
      // worse place to trade, which defeats the point of putting it here.
      const imp = Number(q.quote.priceImpactPct || 0) * 100;
      const fee = q.quote.platformFee && dec != null ? Number(q.quote.platformFee.amount) / 10 ** dec : 0;
      out.innerHTML = (o == null ? 'Route found.' : `You receive about <b>${fmtNum(o)} ${h(f.symbol)}</b>`)
        + `<span class="fbmeta"><span class="${imp > 1 ? 'down' : 'dim'}">impact ${imp.toFixed(2)}%</span>`
        + (fee ? `<span class="dim">REX fee ${fmtNum(fee)} ${h(f.symbol)}</span>` : '<span class="dim">no REX fee on this route</span>')
        + `<span class="dim">via ${h((q.quote.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean)[0] || 'direct')}</span></span>`;
      if (o) rate.textContent = `1 SOL ≈ ${fmtNum(o / n)} ${f.symbol}`;
      setGo(S.me ? `Buy ${f.symbol}` : 'Connect wallet to buy', true);
    } catch (e) { q = null; out.textContent = niceErr(e); setGo('No route', false); }
  };
  m.querySelector('#fbAmt').oninput = (e) => { amt = e.target.value.replace(/[^\d.]/g, ''); clearTimeout(timer); timer = setTimeout(quote, 350); };
  m.querySelectorAll('.fbquick button').forEach((b) => b.onclick = () => { amt = b.dataset.a; m.querySelector('#fbAmt').value = amt; quote(); });

  go.onclick = async () => {
    if (!S.me) return connectWallet();
    if (!q || busy) return;
    busy = true; setGo('Working…', false);
    try {
      const built = await api('/api/jup/swap', { quoteResponse: q.quote, userPublicKey: S.me.wallet });
      // The quote was built for S.me.wallet; CHAIN.signTx refuses if the wallet is on a different
      // account rather than letting it fail as an unexplained 4100.
      const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
      const raw = Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0));
      const tx = web3.VersionedTransaction.deserialize(raw);
      const signed = await CHAIN.signTx(tx);
      const { signature } = await api('/api/jup/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
      toast('gold', `Bought <b>$${h(f.symbol)}</b> · <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">view tx</a>`);
      closeModal();
    } catch (e) { out.textContent = niceErr(e); setGo(`Buy ${f.symbol}`, true); }
    busy = false;
  };
}
bus.on('state', renderFeatured);

bus.on('state', renderChainBar);
bus.on('auth', renderChainBar);

// The nav links scroll when they do not fit. CSS cannot ask "am I overflowing?", so the fade that
// says "there is more this way" is toggled here — and only when it is true.
(function navScrollHint() {
  const el = document.querySelector('#nav .links');
  if (!el) return;
  const sync = () => el.classList.toggle('scrolls', el.scrollWidth > el.clientWidth + 2);
  sync();
  new ResizeObserver(sync).observe(el);
  addEventListener('resize', sync);
})();

// ---------- live indicator + mobile tab bar
bus.on('ws', (st) => document.getElementById('tape').classList.toggle('offline', st !== 'open'));
function markMobile(p) { const k = p === '/' ? 'home' : p.startsWith('/pairs') ? 'pairs' : p.startsWith('/fair') ? 'fair' : p === '/create' ? 'create' : p.startsWith('/swap') ? 'swap' : p.startsWith('/build') ? 'build' : p.startsWith('/growth') ? 'growth' : p.startsWith('/leader') ? 'board' : p.startsWith('/rewards') ? 'rewards' : p === '/me' || p.startsWith('/u/') ? 'me' : ''; document.querySelectorAll('#mnav a').forEach((a) => a.classList.toggle('active', a.dataset.m === k)); document.body.classList.toggle('token-page', p.startsWith('/t/')); }
// ---------- ticker tape
const tape = document.getElementById('tapeTrack'); let tapeItems = [];
const tk = (t) => `<a class="tk" href="/t/${h(t.mint)}" data-link title="Open $${h(t.symbol)}">${av(t, 'xs')}<b>$${h(t.symbol)}</b><span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '▲' : '▼'} ${fmtNum(t.quote)} ${h(t.quoteSymbol)}</span><span class="dim">${t.runCount > 1 ? `x${t.runCount}` : h(t.who || short(t.wallet))}</span>${t.kind === 'fairopen' ? `<span class="gold">${icon('scales')}</span>` : ''}</a>`;
let tapeDirty = false, tapeAt = 0;
/**
 * ⛔ COLLAPSE CONSECUTIVE TRADES OF THE SAME COIN INTO ONE ENTRY.
 * The tape is one trade per slot, which is right when a dozen coins are trading and useless when
 * one is: $BITE filled the entire strip seven times over because it was the only thing moving, and
 * a reader learns nothing from the second repeat that they did not learn from the first. A run is
 * now a single entry carrying its own count and its summed size, so the information survives — you
 * can still see there were seven sells and how much they came to — while the strip gets its variety
 * back. Only CONSECUTIVE runs collapse: the same coin reappearing later in the tape is a separate
 * burst and still earns its own slot.
 */
function collapseRuns(list) {
  const out = [];
  for (const t of list) {
    const last = out[out.length - 1];
    if (last && last.mint === t.mint && last.side === t.side) {
      last.runCount = (last.runCount || 1) + 1;
      last.quote += t.quote;
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

/**
 * ⛔ ONE BUSY COIN MUST NOT BE THE WHOLE TAPE.
 * Collapsing consecutive runs was not enough: when a single coin is the only thing trading it still
 * takes every slot, just with gaps between its own entries, and the strip reads as though the pad
 * has one coin on it. A tape is a view of the MARKET, so each coin gets at most a couple of slots
 * and the rest of the strip is filled with the most recent trade of every other coin that has one —
 * older, but true, and far more use than the same ticker eight times.
 */
function spreadAcrossCoins(list, perMint = 2) {
  const seen = new Map(), kept = [], spill = [];
  for (const t of list) {
    const n = seen.get(t.mint) || 0;
    if (n < perMint) { seen.set(t.mint, n + 1); kept.push(t); } else spill.push(t);
  }
  // Only fall back to one coin's overflow if there genuinely is nothing else to show.
  return kept.length >= 6 ? kept : kept.concat(spill);
}
function renderTape(force = false) { if (!force && (Date.now() - tapeAt < 40_000 || document.hidden)) { tapeDirty = true; return; } const items = spreadAcrossCoins(collapseRuns(tapeItems)).slice(0, 24); const html = items.map(tk).join(''); tape.innerHTML = html + html; tapeAt = Date.now(); tapeDirty = false; }
bus.on('state', (st) => { if (!tapeAt) { tapeItems = st.feed || []; renderTape(true); } });
bus.on('trade', (m) => { tapeItems.unshift(m); if (tapeItems.length > 40) tapeItems.length = 40; renderTape(); });
setInterval(() => { if (tapeDirty) renderTape(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && tapeDirty) renderTape(true); });


// Effects fire from the thing that changed. A toast is the thing that changed, so the burst comes
// out of it — a screen-wide shower tells you something happened but not where to look.
function fxToast(kind = '') {
  requestAnimationFrame(() => {
    const t = document.querySelector('.toast:last-of-type') || document.querySelector('.toast');
    if (t) burst(t, { count: kind === 'gold' ? 24 : 16, power: kind === 'gold' ? 10 : 7 });
  });
}

// ---------- global notifications
bus.on('toast', (t) => toast(t.kind, t.text));
/**
 * No wallet — which on a phone is a different problem from the one this used to solve.
 *
 * Elio, 7 Oct: "for people with no wallet fam". The old modal offered a link to phantom.app, which
 * on desktop installs an extension and works. On a phone it opens the App Store, and after the
 * install the person is still in Safari, where there is still no wallet — the site has no way to
 * reach the one they just installed. That is most of the people this was supposed to help.
 *
 * Every mobile wallet solves this with a universal link that reopens the CURRENT page inside its own
 * browser, where the wallet is injected. One tap, no re-navigation, and they land exactly where they
 * were. So on a phone that is the offer, and the install links are the fallback rather than the lead.
 */
const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const here = () => location.href;
const WALLET_OPEN = [
  ['Phantom', (u) => `https://phantom.app/ul/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(location.origin)}`],
  ['Solflare', (u) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(u)}?ref=${encodeURIComponent(location.origin)}`],
];
const WALLET_GET = [['Phantom', 'https://phantom.app/download'], ['Solflare', 'https://solflare.com/download'], ['Backpack', 'https://backpack.app/download']];
bus.on('nowallet', () => {
  const phone = isPhone();
  const body = phone
    ? `<h3>Open this page in your wallet</h3>
       <p class="muted" style="margin:10px 0 16px;line-height:1.5">On a phone a wallet lives inside its own browser. These reopen <b>this exact page</b> there — you will land back where you are now, signed in with one free message signature. No transaction, no gas.</p>
       <div class="stack">${WALLET_OPEN.map(([n, f]) => `<a class="btn cta" href="${f(here())}" rel="noopener"><span>Open in ${n}</span></a>`).join('')}
       <div class="hint" style="margin:4px 0 0">Haven't got one yet? ${WALLET_GET.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${n}</a>`).join(' · ')}</div>`
    : `<h3>No Solana wallet detected</h3>
       <p class="muted" style="margin:10px 0 16px;line-height:1.5">REX Chain signs you in with a free message signature from Phantom, Backpack or Solflare — no transaction, no gas.</p>
       <div class="stack">${WALLET_GET.map(([n, u], i) => `<a class="btn ${i ? '' : 'cta'}" href="${u}" target="_blank" rel="noopener"><span>Get ${n}</span></a>`).join('')}`;
  // ⛔ ONLY DRAWN WHEN THE DEPLOYMENT HAS AN APP ID. A button for a service that is not configured
  // is worse than no button: it is a dead end discovered after somebody has typed their email in.
  const email = S.privyAppId
    ? `<div class="pvy"><div class="pvy-or"><span>or</span></div>
         <div class="hint" style="margin-bottom:8px">No wallet at all? Sign in with an email and one is made for you — you hold the keys, not us.</div>
         <div class="sb-in"><input id="pvyEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"><button class="btn" id="pvySend">Send code</button></div>
         <div class="sb-in" id="pvyCodeRow" hidden><input id="pvyCode" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code"><button class="btn cta" id="pvyGo">Sign in</button></div>
         <div class="sb-note" id="pvyNote"></div></div>`
    : '';
  const m = modal(`${body}${S.sim ? '<button class="btn" id="demoW">Try with a demo wallet (paper funds)</button>' : ''}<button class="btn ghost" id="closeW">Close</button></div>${email}`);
  document.getElementById('closeW').onclick = closeModal;
  const d = document.getElementById('demoW'); if (d) d.onclick = async () => { closeModal(); await demoWallet(); };

  if (S.privyAppId) {
    const note = document.getElementById('pvyNote');
    const say = (t, bad) => { note.textContent = t; note.style.color = bad ? 'var(--down)' : ''; };
    const send = document.getElementById('pvySend');
    const go = document.getElementById('pvyGo');
    send.onclick = async () => {
      const addr = document.getElementById('pvyEmail').value.trim();
      send.disabled = true; say('Setting up…');
      try {
        const { privy } = await import('/state.js');
        const p = await privy();
        await p.sendCode(addr);
        document.getElementById('pvyCodeRow').hidden = false;
        document.getElementById('pvyCode').focus();
        say(`Code sent to ${addr}.`);
      } catch (e) { say(niceErr(e, 'Could not send the code'), true); }
      send.disabled = false;
    };
    go.onclick = async () => {
      go.disabled = true; say('Signing you in…');
      try {
        const { privyLogin } = await import('/state.js');
        const me = await privyLogin(document.getElementById('pvyEmail').value.trim(), document.getElementById('pvyCode').value.trim());
        if (me) { closeModal(); return; }
        say('That did not complete — try the code again', true);
      } catch (e) { say(niceErr(e, 'That code did not work'), true); }
      go.disabled = false;
    };
    document.getElementById('pvyEmail').onkeydown = (e) => { if (e.key === 'Enter') send.click(); };
    document.getElementById('pvyCode').onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
  }
});
bus.on('graduated', (m) => { toast('gold', `${icon('cap')} <b>$${h(m.symbol)}</b> graduated to the AMM`, m.image); fxToast('gold'); });
bus.on('token', (m) => toast('ok', `${icon('flame')} New launch: <b>${h(m.token.name)}</b> $${h(m.token.symbol)}${m.token.status === 'fairopen' ? ' — Fair Open running' : ''}`, m.token.image));
bus.on('settled', (m) => { if (m.bidders > 0) { toast('gold', `${icon('scales')} <b>$${h(m.symbol)}</b> Fair Open cleared · ${m.bidders} bidders at one price`, m.image); fxToast('gold'); } });
// Epoch payouts arrive as one event per coin — batch them into a single pop.
let yieldBuf = [], yieldT = null;
bus.on('yield', (m) => { yieldBuf.push(m); clearTimeout(yieldT); yieldT = setTimeout(flushYield, 700); });
function flushYield() {
  const evs = yieldBuf; yieldBuf = []; if (!evs.length) return;
  const usd = evs.reduce((s, m) => s + m.pool * usdOf(m.quote), 0); const holders = evs.reduce((s, m) => s + m.holders, 0);
  const mine = S.me ? evs.flatMap((m) => m.top.filter((p) => p.wallet === S.me.wallet).map((p) => ({ ...p, quote: m.quote }))) : [];
  const mineUsd = mine.reduce((s, p) => s + p.amount * usdOf(p.quote), 0);
  document.querySelector('.payout-pop')?.remove();
  const el = document.createElement('div'); el.className = 'payout-pop';
  const imgs = evs.slice(0, 4).map((m) => `<img class="av xs" src="${h(m.image || '/brand/rex-glyph.png?v=2')}">`).join('');
  el.innerHTML = evs.length === 1
    ? `<img class="av sm" src="${h(evs[0].image || '/favicon.svg')}"><div>${icon('gem', 'ic-gold')} <b>$${h(evs[0].symbol)}</b> paid <b>${fmtQ(evs[0].pool, evs[0].quote)}</b> to ${evs[0].holders} holders${mine.length ? ` · <span class="up">you +${fmtNum(mine[0].amount)} ${h(mine[0].quote)}</span>` : ''}</div>`
    : `<div class="stackav">${imgs}</div><div>${icon('gem', 'ic-gold')} Epoch paid <b>${fmtUsd(usd)}</b> across <b>${evs.length} coins</b> to ${holders} holders${mineUsd > 0 ? ` · <span class="up">you +${fmtUsd(mineUsd)}</span>` : ''}</div>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 6000); if (S.me) refreshMe();
  // ⛔ THE BIG ONE IS RESERVED FOR MONEY THAT LANDED IN YOUR WALLET. An epoch pays every holder of
  // every coin and fires constantly; celebrating all of them would make the celebration mean
  // "a thing occurred", which is worth nothing. `mineUsd > 0` is the whole gate: this went to YOU.
  if (mineUsd > 0 || mine.length) { celebrate(['#ffc24d', '#3dffa0', '#9dff8f', '#22c55e']); pulse(el, 'gold'); }
  else burst(el, { count: 12, power: 6 });
}
bus.on('epoch', () => { if (S.me) refreshMe(); });
async function refreshMe() { try { const st = await api('/api/state'); S.me = st.me; renderWallet(); } catch {} }

// ---------- embers (canvas, cheap)
(function embers() {
  const c = document.getElementById('embers'); const ctx = c.getContext('2d'); let W, H, ps = [], raf;
  const resize = () => { W = c.width = innerWidth; H = c.height = Math.min(innerHeight, 900); }; resize(); addEventListener('resize', resize);
  const mk = () => ({ x: Math.random() * W, y: H + 10, r: 0.6 + Math.random() * 1.8, v: 0.25 + Math.random() * 0.7, d: (Math.random() - 0.5) * 0.3, a: 0.15 + Math.random() * 0.5, t: Math.random() * 6.28 });
  for (let i = 0; i < 70; i++) { const p = mk(); p.y = Math.random() * H; ps.push(p); }
  const step = () => { if (document.hidden) { raf = requestAnimationFrame(step); return; } ctx.clearRect(0, 0, W, H); for (const p of ps) { p.y -= p.v; p.x += Math.sin(p.t += 0.02) * 0.3 + p.d; if (p.y < -10) Object.assign(p, mk()); const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4); g.addColorStop(0, `rgba(255,170,80,${p.a})`); g.addColorStop(1, 'rgba(255,106,26,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, 6.28); ctx.fill(); } raf = requestAnimationFrame(step); };
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) step();
})();

// ---------- boot
(async () => {
  try { await loadState(); } catch (e) { toast('err', 'Server unreachable'); }
  // A Privy wallet has to be brought back before anything asks for a signature, or somebody who
  // signed in with an email is silently signed out by pressing refresh. Best-effort and never
  // blocking: the page renders either way and a failure just means signing in again.
  restorePrivy().catch(() => {});
  renderWallet(); connectWs(); route();
  // Follow the wallet when it changes account. Registered once, after the first state load, so a
  // switch during boot cannot race the session it would be replacing.
  watchWallet();
  document.getElementById('footNote').textContent = S.sim ? 'demo market · paper balances' : '';
  // A paper market that does not say so reads as a broken real one. Say it above the fold. A cluster
  // deployment has its own notice (renderChainBar) with the faucet built in, so this is paper only.
  const bar = document.getElementById('simbar');
  if (S.sim) {
    bar.innerHTML = '<b>Demo market.</b> Every coin, price and balance here is paper — nothing touches a chain. '
      + 'The mechanics are the real ones: launch, Fair Open, the curve, holder rewards. <a href="/learn" data-link>How it works</a>';
  }
  bar.hidden = !S.sim;
  renderLangSwitch();
  renderCa();
  // The Swap tab only exists when the server says swaps are on.
  // Both bars, not just the desktop one. Hiding only the header tab is what left the phone with
  // no way to reach /swap at all.
  if (S.swap) for (const id of ['navSwap', 'mnavSwap']) document.getElementById(id)?.removeAttribute('hidden');
  // Started last, so the first sweep sees a page that is already rendered.
  startI18n();
})();
