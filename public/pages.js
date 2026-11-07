import { S, api, bus, subscribe, usdOf, quoteOf, connectWallet } from '/state.js';
import * as CHAIN from '/chain.js';
const gateChip = () => {
  // Anyone can launch. Holding $REX buys a better rate, and because REX's fee comes out of the
  // holder allocation, the discount lands with that token's holders rather than the creator.
  const r = S.me?.rexRate, need = S.gate?.rexRateHoldUsd || 0;
  if (!need) return '';
  if (!S.me) return `<span class="chip">Hold $${fmtNum(need)} of $REX for a better launch rate</span>`;
  return r?.qualifies
    ? `<span class="chip conv">✓ Your launches open at ${(r.bps / 100).toFixed(2)}% REX fee — ${((r.standard - r.bps) / 100).toFixed(2)}% better, and it goes to your holders</span>`
    : `<span class="chip">Opens at ${(r?.standard ?? 50) / 100}% · hold $${fmtNum(need)} of $REX (you hold ${fmtUsd(S.me.rexUsd || 0)}) for a better rate</span>`;
};
import { icon } from '/icons.js';
import { burst, celebrate, flash, countTo } from '/fx.js';
import { h, short, copyText, niceErr, fmtNum, fmtUsd, fmtQ, fmtPrice, pct, ago, mmss, av, badges, spark, ring, tickRing, tier, tokenCard, socialLinks, toast, modal, closeModal, flashNum, walletLink, mountChart, qchip, tickUp } from '/ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const every = (ms, fn) => { const id = setInterval(fn, ms); return () => clearInterval(id); };
const uspStrip = () => `<div class="usps">
  <div class="usp"><div class="t"><span class="n">1</span>Fair Open — nobody gets the first bite</div><p>Every launch opens with a sealed window. All commitments in it — the dev's included — clear as one buy at one price, allocated pro-rata. No block-0 snipers, no first-in-line edge.</p></div>
  <div class="usp"><div class="t"><span class="n">2</span>Paid in the quote asset, on swaps only</div><p>Every epoch pays holders pro-rata to their balance, in the asset the pair trades against — on a visible countdown. A send pays nothing, and the launched token is never sold to fund its own payout.</p></div>
  <div class="usp"><div class="t"><span class="n">3</span>Every holder is a distributor</div><p>A creator can hand part of their own cut to whoever brings the volume. It costs holders and the 5% ceiling nothing, so the people selling the coin are paid by the person who launched it.</p></div>
</div>`;

// ============================================================ HOME / DISCOVER
export async function home(root, { fairOnly = false } = {}) {
  let sort = localStorage.getItem('forge_sort') || 'trending', quote = null, q = '';
  const st = S.stats || {};
  root.innerHTML = `<div class="fade">
    ${fairOnly ? '' : `<section class="hero">
      <div><div class="eyebrow"><i></i>The $REX ecosystem</div>
        <h1>Launch. Build. Trade.<br><span class="grad-text">Discover. Grow.</span></h1>
        <p class="lead">REX Chain isn't a launchpad with an ecosystem around it — it's an <b class="ember">ecosystem with a launch infrastructure layer at its core</b>, and the whole thing is one <b class="ember">flywheel</b>: every swap pays holders, every launch deepens $REX, and every coin that grows turns the wheel again. A pair clears at one sealed price. Holders are paid in the quote asset on swaps only, so a send costs nothing and your coin is never sold to fund its own payout. And every holder has a link that earns them a cut of what they bring.</p>
        <div class="verbs">
          <a href="/create" data-link><b>Launch</b><span>One sealed price</span></a>
          <a href="/build" data-link><b>Build</b><span>Open API &amp; embeds</span></a>
          <a href="/" data-link><b>Trade</b><span>Holder rewards</span></a>
          <a href="/fair-opens" data-link><b>Discover</b><span>Opens in flight</span></a>
          <a href="/growth" data-link><b>Grow</b><span>Share &amp; earn</span></a>
        </div>
        <div class="actions"><a class="btn cta lg" href="/create" data-link><span>Launch a coin</span></a><a class="btn lg ghost" href="/growth" data-link>Share &amp; earn</a></div>
        <div class="row wrap" style="margin-top:16px">${gateChip()}</div></div>
      <div class="heromask" aria-hidden="true"></div>
      ${uspStrip()}
    </section>
    <div class="stats" id="stats">${statTiles(st)}</div>
    <div id="flywheel">${flywheel(st)}</div>
    <div id="burnstrip"></div>
    <div id="buysfeed"></div>
    <section class="pgpromo">
      <div class="eyebrow"><i></i>New — pick a program</div>
      <h2>Your fees, doing something.</h2>
      <p>Every coin collects a fee on every swap. What that fee <b class="ember">does</b> is yours to choose — and you can change your mind.</p>
      <div class="pgwrap">
        <a class="pgcard" href="/create?program=AI" data-link><b>${icon('bot')}AI</b><span>A model re-splits each hour's fees between burn, holders and treasury — inside caps you set. Or saves them and buys the dip.</span></a>
        <a class="pgcard" href="/create?program=Pay%20holders" data-link><b>${icon('gem')}Pay holders</b><span>Diamond Hands, Whale Club, Shrimp Fund, Flat Dividend — or pay your holders a basket of $DOGE, $WIF and SOL instead.</span></a>
        <a class="pgcard" href="/create?program=Burn" data-link><b>${icon('flame')}Burn</b><span>Every fee buys your token on the open market and destroys it. Supply only goes down.</span></a>
        <a class="pgcard" href="/create?program=Recipes" data-link><b>${icon('flask')}Recipes</b><span>When this, then that. Wire a trigger to conditions and actions and your fees follow the rule, checked on a schedule.</span></a>
      </div>
      <div class="actions"><a class="btn cta" href="/create" data-link><span>Pick a program</span></a><a class="btn ghost" href="/learn" data-link>How it works</a></div>
      <div class="hint">A program can only move the buckets you opened. It can never name a wallet, raise a cap, or change what REX Chain takes.</div>
    </section>
    ${S.swap ? `<section class="swappromo">
      <img src="/assets/art/rex-community.jpg" alt="" width="200" height="200" loading="lazy" decoding="async">
      <div class="sp-body">
        <div class="eyebrow"><i></i>Any coin for any coin</div>
        <h2>Swap</h2>
        <p>Every token on Solana, routed for the best price. <b class="ember">${((S.swap.feeBps || 33) / 100).toFixed(2)}%</b> per swap — and that fee is REX Chain income, so a swap here turns the same flywheel a launch does.</p>
        <div class="actions"><a class="btn cta" href="/swap" data-link><span>Open swap</span></a><a class="btn ghost" href="/learn" data-link>Where the fee goes</a></div>
      </div>
    </section>` : ''}`}
    ${fairOnly ? '<div class="sec"><h2><span class="live-dot"></span>Fair Opens live now</h2><span class="muted">Sealed windows — everyone inside pays the same price</span></div>' : '<div class="sec"><h2><span class="live-dot"></span>Fair Opens live now</h2><a class="muted" href="/fair-opens" data-link>See all →</a></div>'}
    <div class="rail" id="foRail"></div>
    ${fairOnly ? '<div class="sec"><h2>Recently cleared</h2></div><div class="grid" id="grid"></div>' : `
    <div id="king"></div>
    <div class="sec"><h2>Discover</h2><div class="row wrap"><div class="chips" id="qchips"><span class="chip on" data-q="">All pairs</span>${
      // Fourteen quote assets is too many chips. The four defaults are always here; the META and
      // Stocks pairs join once a coin is actually quoted in one (filled in by load()).
      S.quotes.filter((x) => ['native', 'stable', 'custom'].includes(x.category))
        .map((x) => `<span class="chip" data-q="${x.symbol}"><i class="qd" style="background:${x.color}"></i>${x.symbol}</span>`).join('')}</div>
      <div class="tabs" id="sorts">${[['trending', icon('flame') + 'Trending'], ['new', icon('sparkle') + 'New'], ['graduating', icon('cap') + 'Graduating'], ['paid', icon('gem') + 'Most paid'], ['volume', icon('chart') + 'Volume'], ['mcap', icon('vault') + 'Mcap']].map(([k, l]) => `<button data-s="${k}" class="${k === sort ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>
    <div class="grid" id="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`}
  </div>`;
  const grid = $('#grid', root), rail = $('#foRail', root);

  /**
   * The burn, on the front page.
   *
   * It was a click away on /rewards, which meant the single most bullish number the project has —
   * REX permanently destroyed — was invisible to anyone who did not go looking. It loads after the
   * first paint and simply does not appear if the figures are not there, so a slow upstream costs a
   * strip rather than the page.
   */
  /**
   * ⛔ THIS PANEL USED TO RENDER EXACTLY ONCE AND THEN SIT THERE FOR AS LONG AS THE TAB WAS OPEN.
   *
   * Which is, precisely and literally, "Doesn't update" — Julz screenshotted it twice saying so,
   * and he was right in a way nobody had looked for: the figures were fetched on first paint and
   * nothing ever asked again. A burn could fire, the pot could fill, and this strip would go on
   * showing the numbers from whenever the page happened to be loaded. Elio asked for it on the
   * epoch — "All data accurate like Santa" — so it redraws on the epoch tick the server already
   * broadcasts, and on a two-minute floor besides.
   */
  const drawBurn = async () => {
    try {
      const d = await api('/api/rewards');
      const b = d.burn; if (!b || !(Number(b.burnedByBuybacks) > 0)) return;
      const el = $('#burnstrip', root); if (!el) return;
      const usd = Number(d.analytics?.priceUsd) || 0;
      const burned = Number(b.burnedByBuybacks), bought = Number(b.boughtBack);
      const last = b.lastBurn;
      // ⛔ THE POT IS THE ONLY NUMBER ON THIS STRIP THAT MOVES. Everything else is a lifetime total,
      // so between burns the strip is byte-identical on every visit — Julz read "last burn 12d ago"
      // as the panel being broken and asked for "more accurate updates". It was telling the truth:
      // the last burn really was 12 days earlier, because burns fire only when the pot reaches its
      // threshold and it was at $5.61 of $100. /rewards has shown that bar all along; the strip on
      // the front page, which is what people actually look at, did not — so the one fact that
      // explains the gap was on a page nobody had a reason to open.
      const pot = Number(b.potUsd) || 0, target = Number(b.potTargetUsd) || 0;
      // A day without a single lamport arriving is not a slow hour; it is a stopped pipe.
      //
      // ⛔ THE SECOND CLAUSE MATTERS ON DAY ONE. Movement tracking can only start when we first look,
      // so on a pot that has already been frozen for twelve days the first clause stays false for a
      // further twenty-four hours and the panel goes on implying progress for another day. A pot
      // sitting at a twentieth of its threshold with nothing burned in a week is not approaching
      // one, and that much is knowable immediately from figures the feed already gives us.
      const sinceBurn = last?.at ? Date.now() - last.at : 0;
      const stale = (Number(b.potStaleMs) > 24 * 3600_000 && b.potMovedAt)
        || (sinceBurn > 7 * 24 * 3600_000 && target > 0 && pot < target * 0.25);
      const over = target > 0 && pot >= target;
      const potPct = target > 0 ? Math.min(100, (pot / target) * 100) : 0;
      el.innerHTML = `<a class="burnhero" href="/rewards" data-link>
        <!-- ⛔ MORE EMBERS AND A TALLER BED THAN THE OLD STRIP. Elio asked for "bigger and more easy
             to read and big flames", and Julz had already reported the burn section as having no
             fire while nine embers were genuinely running — at strip height they were a few pixels
             of warmth behind text. The fire only reads as fire when it has room, so the panel is
             sized for it rather than the fire being squeezed into a line of figures. -->
        <i class="bs-fire" aria-hidden="true">${'<b></b>'.repeat(26)}</i>
        <!-- ⛔ A SECOND FLAME ELEMENT, because one layer cannot dance. ::before and ::after on
             .bs-fire are already the glow bed and the first set of tongues; convincing fire needs
             at least two tongue sets running at different speeds and drifting against each other,
             so a single element breathing in and out reads as a pulsing gradient instead. This one
             carries sets B and C. -->
        <i class="bs-flames" aria-hidden="true"></i>
        <img class="bs-art" src="/assets/art/rex-burn.jpg" alt="" width="208" height="208" loading="lazy" decoding="async">
        <span class="bh-body">
          <span class="bh-tag">${icon('flame')}<span>Buyback and burn</span></span>
          <span class="bh-h">Buying back and burning REX</span>
          <span class="bh-last">${last?.at ? `<span>last burn</span> ${ago(last.at)} <span>ago</span>` : '<span>no burn yet</span>'}</span>
          <span class="bh-stats">
            <span class="bh-stat"><span class="bh-n ticker" data-to="${burned}" data-suffix=" REX">0 REX</span><span class="bh-l">burned by the program</span></span>
            <span class="bh-stat"><span class="bh-n">${fmtNum(bought)} REX</span><span class="bh-l">bought back and held</span></span>
            ${usd ? `<span class="bh-stat"><span class="bh-n">${fmtUsd((burned + bought) * usd)}</span><span class="bh-l">taken off the market</span></span>` : ''}
          </span>
          ${target > 0 ? `<span class="bh-pot">
            <span class="prog burnbar big"><i style="width:${Math.max(potPct, 1.5).toFixed(1)}%"></i></span>
            <!-- Figure and words in SEPARATE nodes: a node holding both is a different string every
                 time the pot moves, so ES mode could never match it. -->
            <!-- ⛔ A POT THAT IS NOT FILLING MUST NOT LOOK LIKE ONE THAT IS. "next burn fires at $100"
               reads as progress; with nothing arriving it is a promise about a queue that is not
               moving. Twelve days of no fees reaching the payer wallet is the thing worth saying. -->
          <!-- ⛔ "UNVERIFIED" IS A THIRD STATE, and it has to be said out loud. The burn figures come
               from a separate service; when its RPC key is exhausted it reports the pot as 0, and a
               panel that prints that is telling the reader the pot is empty when the chain says it
               is not. The last figure we are sure of is shown, labelled as such. -->
          <!-- ⛔ A POT PAST ITS THRESHOLD IS NOT A POT APPROACHING ONE, AND THIS SAID IT WAS.
               Both honest states above need the pot to be LOW: the stale branch wants it under a quarter of
               target, and neither looks at the case that actually held — $278 sitting against a
               $100 threshold, fees still arriving daily, nothing burned in eighteen days. So the
               strip fell through to "next burn fires at $100" and read as progress toward a line it
               had already crossed 2.8x over. That is the exact sentence Elio screenshotted twice.
               The threshold was never what the burn was waiting on: the scheduler in rex-rewards
               has never been switched on, so every burn there has ever been was an admin pressing
               Run, and the panel now says which of those it is waiting for. -->
          <span class="prog-l"><span>${fmtUsd(pot)} <span>in the pot</span></span><span>${b.potUnverified
            ? '<span>last confirmed figure — the burn service is not answering right now</span>'
            : over
              ? (b.autoOn
                ? '<span>past the threshold — burning on the next run</span>'
                : '<span>past the threshold — waiting on a manual run</span>')
              : stale
                ? `<span>no fees have reached it in</span> ${ago(b.potMovedAt && Number(b.potStaleMs) > 24 * 3600_000 ? b.potMovedAt : last.at)}`
                : `<span>next burn fires at</span> ${fmtUsd(target)}`}</span></span>
          </span>` : ''}
          <span class="bh-go"><span>the ledger</span> →</span>
        </span></a>`;
      tickUp(el);
    } catch {}
  };
  drawBurn();
  // The epoch is the beat the whole site runs on, and it is the one the team asked to be tied to.
  // Collected here and handed to the page's teardown list further down — `offs` is declared below
  // and touching it from up here is a temporal-dead-zone throw, which would take the home page out.
  const burnOffs = [bus.on('epoch', drawBurn), every(120_000, drawBurn)];

  /**
   * RECENT BUYS.
   *
   * The ticker tape at the top of every page already carries every trade, and it is the wrong shape
   * for the question people actually arrive with — "is anything being bought right now, and by
   * whom?". A tape is a strip of glyphs sliding past: you cannot compare two entries, the sizes are
   * in whatever each pair is quoted in, and a sell looks like a buy at a glance. So MiKOL asked for
   * a feed, and a feed is a list: one row per buy, newest first, every size in the same units, and a
   * standing marker for the thing a tape can never tell you — whether the buyer is new to the coin.
   *
   * Loaded after first paint and simply absent if the request fails, like the burn strip above: a
   * slow upstream costs this panel, never the page.
   */
  const buysBox = $('#buysfeed', root);
  let buys = [];
  const BUYS_MAX = 14;
  const buyRow = (b) => `<a class="bf-row${b.firstBuy ? ' is-new' : ''}" href="/t/${h(b.mint)}" data-link title="Open $${h(b.symbol)}">
    ${av(b, 'xs')}
    <span class="bf-sym">$${h(b.symbol)}</span>
    <!-- Name and badge share ONE grid cell. As separate columns the badge was pushed to the far
         right by the flexible track and ended up annotating the size instead of the buyer, which is
         the only thing it is about. Each stays its own text node, because the ES dictionary matches
         whole nodes and exactly — a node mixing a wallet name with a word can never match. -->
    <span class="bf-buyer"><span class="bf-who">${h(b.who || short(b.wallet))}</span><span class="bf-tag">${b.firstBuy ? 'new holder' : ''}</span></span>
    <span class="bf-size">${b.usd >= 0.005 ? fmtUsd(b.usd) : `${fmtNum(b.quote)} ${h(b.quoteSymbol)}`}</span>
    <span class="bf-ago">${ago(b.ts)}</span>
  </a>`;
  function paintBuys() {
    if (!buysBox) return;
    if (!buys.length) { buysBox.innerHTML = ''; return; }
    buysBox.innerHTML = `<section class="buysfeed">
      <div class="bf-head"><h2><span class="live-dot"></span>Recent buys</h2><a class="muted" href="/leaderboard" data-link>Top buyers →</a></div>
      <div class="bf-list">${buys.slice(0, BUYS_MAX).map(buyRow).join('')}</div>
    </section>`;
  }
  (async () => {
    try {
      const d = await api('/api/buys?limit=' + BUYS_MAX);
      buys = Array.isArray(d.buys) ? d.buys : [];
      paintBuys();
    } catch {}
  })();
  // ⛔ THE LIVE ROW IS THE WHOLE POINT, so it must not depend on a refetch. Every buy on the site
  // already arrives on this socket with its USD size and its firstBuy flag worked out server-side,
  // so a new row costs one unshift. A trade with no symbol is a trade for a coin this page has
  // never heard of and is skipped rather than rendered as `$undefined`.
  const buyOffs = [];
  buyOffs.push(bus.on('trade', (m) => {
    if (m.side !== 'buy' || !m.symbol) return;
    buys.unshift({ ...m, usd: Number(m.usd) || 0 });
    if (buys.length > BUYS_MAX * 2) buys.length = BUYS_MAX * 2;
    paintBuys();
    try { flash($('.bf-list > .bf-row', root), 'fx-flash'); } catch {}
  }));
  // The relative times go stale sitting there; re-stamp them without refetching anything.
  buyOffs.push(every(15_000, () => { if (buys.length) paintBuys(); }));

  let tokens = [], first = true;
  /** Add a chip for any META / Stocks pair that a live coin is quoted in, once we know. */
  function syncQuoteChips() {
    const box = $('#qchips', root); if (!box) return;
    const have = new Set([...box.querySelectorAll('.chip')].map((c) => c.dataset.q));
    for (const sym of new Set(tokens.map((t) => t.quote))) {
      if (have.has(sym)) continue;
      const qa = S.quotes.find((x) => x.symbol === sym); if (!qa) continue;
      const el = document.createElement('span');
      el.className = 'chip'; el.dataset.q = sym;
      el.innerHTML = `<i class="qd" style="background:${qa.color}"></i>${sym}`;
      el.onclick = () => { quote = sym; $$('#qchips .chip', root).forEach((x) => x.classList.toggle('on', x === el)); load(); };
      box.appendChild(el);
    }
  }
  /**
   * `user: true` means a person just did something — typed in the search box, picked a sort, chose a
   * quote. Those must ALWAYS fetch.
   *
   * The hidden-tab guard exists to stop the background refresh timer burning requests in a tab
   * nobody is looking at, which is right. But it was also swallowing user actions, and that is how
   * "the search bar doesn't work" happens: Telegram's in-app browser and backgrounded mobile tabs
   * report document.hidden, so you type, nothing fetches, nothing re-renders, and nothing ever
   * retries. The guard now applies only to the automatic refreshes it was written for.
   */
  async function load(opts = {}) {
    if (!first && !opts.user && document.hidden) return;
    // A search that matches nothing used to render "Nothing here yet." — a sentence about the SITE,
    // not about the search. Typing a ticker that is not listed therefore looked exactly like a page
    // that had failed to load, which is how it was reported ("doesn't load when searching"). Say
    // which of the three situations it actually is, and always offer the way back out.
    if (opts.user) grid.innerHTML = '<div class="skeleton"></div>'.repeat(3);
    const [r, live] = await Promise.all([fairOnly ? api('/api/tokens?sort=new&limit=60') : api(`/api/tokens?sort=${sort}${quote ? '&quote=' + quote : ''}${q ? '&q=' + encodeURIComponent(q) : ''}&limit=60`), api('/api/fairopens')]);
    tokens = r.tokens; S.king = live.king;
    syncQuoteChips();
    const fo = live.tokens; const rest = fairOnly ? tokens.filter((t) => t.status !== 'fairopen' && t.fairOpenSecs > 0).slice(0, 24) : tokens.filter((t) => t.status !== 'fairopen');
    const card = (t) => tokenCard(t, { animate: first });
    rail.innerHTML = fo.length ? fo.map(card).join('') : `<div class="empty">No Fair Open running right now — <a href="/create" data-link class="gold">launch one</a>.</div>`;
    grid.innerHTML = rest.length ? rest.map(card).join('') : emptyGrid();
    first = false;
    if (!fairOnly) renderKing();
  }
  const emptyGrid = () => q
    ? `<div class="empty">Nothing matches <b>${h(q)}</b>. <a href="#" id="clearq" class="gold">Clear the search</a></div>`
    : quote
      ? `<div class="empty">No coin is paired against ${h(quote)} yet — <a href="/create" data-link class="gold">launch the first one</a>.</div>`
      : '<div class="empty">Nothing here yet.</div>';
  function renderKing() {
    const k = S.king; const el = $('#king', root); if (!el) return;
    if (!k) { el.innerHTML = ''; return; }
    // Same shape as a board card, and for the same reason: the strip is one link to the coin, so
    // the coin's own socials cannot be anchors inside an anchor. Absolutely positioned, so the
    // stretched link is not a fourth column of this grid.
    const socs = socialLinks(k, { compact: true });
    el.innerHTML = `<div class="king"><a class="cardlink" href="/t/${k.mint}" data-link aria-label="${h(k.name)} $${h(k.symbol)}"></a>${av(k, 'lg')}<div><div class="crown">${icon('crown')}King of the hill · ${k.dubbed ? `crowned for ${Math.max(1, Math.round((k.crownedUntil - Date.now()) / 3_600_000))}h` : 'most traded this hour'}</div><h3>${h(k.name)} <span class="muted">$${h(k.symbol)}</span></h3><div class="meta">${badges(k)}${socs ? `<span class="socs">${socs}</span>` : ''}</div>
      <div class="kp"><div><div class="l">Mcap</div><div class="v">${fmtUsd(k.mcapUsd)}</div></div><div><div class="l">1h vol</div><div class="v">${fmtUsd(k.vol1h * k.quoteUsd)}</div></div><div><div class="l">1h</div><div class="v ${k.chg1h == null ? 'dim' : k.chg1h >= 0 ? 'up' : 'down'}">${pct(k.chg1h)}</div></div><div><div class="l">Curve</div><div class="v">${(k.progress * 100).toFixed(0)}%</div></div><div><div class="l">Holder rewards</div><div class="v gold">${fmtUsd(k.yieldPaid * k.quoteUsd)}</div></div></div></div>
      <div style="width:160px">${spark(k.spark, 160, 56).replace('class="spark"', 'style="width:160px;height:56px"')}</div></div>`;
  }
  await load();
  const offs = [];
  offs.push(...buyOffs, ...burnOffs);
  $$('#sorts button', root).forEach((b) => b.onclick = () => { sort = b.dataset.s; localStorage.setItem('forge_sort', sort); $$('#sorts button', root).forEach((x) => x.classList.toggle('on', x === b)); load({ user: true }); });
  $$('#qchips .chip', root).forEach((c) => c.onclick = () => { quote = c.dataset.q || null; $$('#qchips .chip', root).forEach((x) => x.classList.toggle('on', x === c)); load({ user: true }); });
  offs.push(bus.on('search', (v) => { q = v; load({ user: true }); }));
  root.addEventListener('click', (e) => {
    if (!e.target.closest('#clearq')) return;
    e.preventDefault();
    const box = document.getElementById('q'); if (box) box.value = '';
    q = ''; load({ user: true });
  });
  let reloadT = null; const softReload = () => { clearTimeout(reloadT); reloadT = setTimeout(load, 900); };
  offs.push(bus.on('token', softReload), bus.on('settled', softReload), bus.on('graduated', softReload));
  offs.push(bus.on('trade', (m) => { const c = root.querySelector(`.card[data-mint="${m.mint}"]`); if (!c) return; const t = tokens.find((x) => x.mint === m.mint); if (!t) return; t.price = m.candle?.c ?? t.price; const usd = usdOf(t.quote); const mc = $('[data-mcap]', c); if (mc) { mc.textContent = fmtUsd(t.price * 1e9 * usd); flashNum(mc, m.side === 'buy' ? 1 : -1); } c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash'); }));
  offs.push(bus.on('fairopen', (m) => { const c = root.querySelector(`.card[data-mint="${m.mint}"]`); if (!c) return; const a = $('[data-fo-total]', c), b = $('[data-fo-bidders]', c); if (!a || !b) return; const q = c.querySelector('.chip .qd')?.nextSibling?.textContent || ''; a.textContent = fmtQ(m.total, q.trim()); b.textContent = m.bidders; }));
  offs.push(bus.on('stats', (m) => {
    const el = $('#stats', root); if (el) el.innerHTML = statTiles(m.stats);
    const fw = $('#flywheel', root); if (fw) fw.innerHTML = flywheel(m.stats);
  }));
  offs.push(bus.on('state', () => renderKing()));
  offs.push(bus.on('auth', () => { const gc = root.querySelector('.gate'); if (gc) gc.outerHTML = gateChip(); }));
  offs.push(every(1000, () => $$('[data-fo-count]', root).forEach((el) => { el.textContent = mmss(Number(el.dataset.foCount) - Date.now()); })));
  offs.push(every(45000, load));
  return () => offs.forEach((f) => f());
}
// ---------- the flywheel
// The site's own pitch is that this is one loop — a swap pays holders, a launch deepens $REX, a
// coin that grows brings the next launch — and until now that claim lived only in a paragraph.
// Drawn, with the real numbers on each stage and a dot actually travelling the arc, it stops being
// a claim and becomes something a reader can watch.
//
// It is SVG rather than canvas on purpose: four labelled nodes that must stay legible at 320px and
// at 900px, and text in canvas is text that does not scale, does not select and does not translate.
// The motion is one CSS animation per dot, so a hidden tab costs nothing and reduced-motion turns
// it off without touching the figures.
function flywheel(st) {
  const R = 118, C = 168;
  // A stage reading "$0" four times says the mechanism is broken; a stage reading "—" says it has
  // not turned yet, which is the true difference and the one a reader needs. The wheel still turns,
  // because it is a diagram of how the thing works, not a readout of how busy it is.
  const quiet = !(st.vol24Usd || st.paidUsd);
  const money = (n) => (quiet && !n ? '—' : fmtUsd(n || 0));
  const NODES = [
    { a: -90, label: 'Swaps', v: money(st.vol24Usd), s: '24h' },
    { a: 0,   label: 'Holders paid', v: money(st.paidUsd), s: `${fmtNum(st.payouts || 0)} payouts` },
    { a: 90,  label: '$REX deepens', v: `${st.graduated || 0}`, s: 'graduated' },
    { a: 180, label: 'New launches', v: `${st.launches || 0}`, s: `${st.launches24 || 0} today` },
  ];
  const pt = (deg, r = R) => [C + r * Math.cos(deg * Math.PI / 180), C + r * Math.sin(deg * Math.PI / 180)];
  const arcs = NODES.map((n, i) => {
    const [x1, y1] = pt(n.a + 13); const [x2, y2] = pt(NODES[(i + 1) % 4].a - 13);
    return `<path class="fw-arc" d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" />`;
  }).join('');
  const dots = NODES.map((n, i) => {
    const [x1, y1] = pt(n.a + 13); const [x2, y2] = pt(NODES[(i + 1) % 4].a - 13);
    // ⛔ NO `begin` DELAY. A circle with no cx/cy sits at the SVG ORIGIN until its animateMotion
    // starts, so a staggered dot parks itself in the top-left corner, outside the wheel, for its
    // whole delay — which is exactly what it looked like. The stagger is unnecessary anyway: each
    // dot already owns a different quarter of the ring, so starting them together is four dots
    // evenly spaced and moving as one, which is what a turning wheel actually looks like.
    return `<circle class="fw-dot" r="3.4">
      <animateMotion dur="4.2s" repeatCount="indefinite"
        path="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" /></circle>`;
  }).join('');
  const labels = NODES.map((n) => {
    const [x, y] = pt(n.a, R);
    const anchor = Math.abs(n.a) === 90 ? 'middle' : n.a === 0 ? 'start' : 'end';
    const dx = anchor === 'start' ? 14 : anchor === 'end' ? -14 : 0;
    // ⛔ THE TOP LABEL OVERLAPPED THE RING. The group is three lines tall (y=0, 15, 28) anchored
    // from its FIRST line, so lifting it by only 16 left "Swaps" at y+(-16+15) and "24h" at
    // y+(-16+28) — both at or below the ring it is supposed to sit above. Elio circled exactly
    // that. The lift has to clear the whole block, not just its first line.
    const dy = n.a === -90 ? -40 : n.a === 90 ? 30 : 0;
    return `<g class="fw-node" transform="translate(${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)})" text-anchor="${anchor}">
      <text class="fw-v" y="0">${h(n.v)}</text>
      <text class="fw-l" y="15">${h(n.label)}</text>
      <text class="fw-s" y="28">${h(n.s)}</text></g>`;
  }).join('');
  const hubs = NODES.map((n) => { const [x, y] = pt(n.a); return `<circle class="fw-hub" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.2"/>`; }).join('');
  return `<section class="fwrap"><div class="fwtext">
      <div class="eyebrow"><i></i>The loop</div>
      <h2>One flywheel, not four features.</h2>
      <p class="muted">A swap pays holders in the quote asset. Those holders stay, which deepens the pair.
        A deeper pair is a better place to launch the next coin — and that coin's swaps pay holders again.
        ${quiet ? 'Nothing has traded yet, so two of these are still blank — they are read from chain, never seeded.'
                : 'Every number on this wheel is live.'}</p>
      <a class="btn cta" href="/learn" data-link><span>How it works</span></a>
    </div>
    <!-- ⛔ THE VIEWBOX IS WIDER THAN THE WHEEL ON PURPOSE. The side labels are anchored outward from
         a ring that fills 0..336, so "New launches" and "Holders paid" are drawn beyond both edges
         and were being clipped on a phone — Ale screenshotted "ew launches". overflow:visible does
         not save them once an ancestor clips. Giving the box 56px of margin each side puts the text
         INSIDE the drawing, which no container can cut. -->
    <svg class="fwheel" viewBox="-56 -6 456 348" role="img" aria-label="The REX Chain flywheel: swaps pay holders, holders deepen the pair, the pair carries the next launch">
      <circle class="fw-ring" cx="${C}" cy="${C}" r="${R}"/>${arcs}${hubs}${dots}${labels}
      <text class="fw-mid" x="${C}" y="${C - 4}" text-anchor="middle">REX</text>
      <text class="fw-mids" x="${C}" y="${C + 14}" text-anchor="middle">CHAIN</text>
    </svg></section>`;
}

function statTiles(st) {
  // ⛔ FOUR $0 TILES READ AS BROKEN, NOT AS NEW. On a pad whose first coin has not traded yet every
  // figure is honestly zero — and a visitor cannot tell that apart from a page whose numbers failed
  // to load, which is what Elio saw. The zeros are not hidden: they are replaced by the one sentence
  // that is actually true, which says the same thing without looking like a fault.
  const quiet = !(st.paidUsd || st.vol24Usd || st.payouts || st.fairOpenFills);
  if (quiet) {
    return `<div class="stat quiet" style="grid-column:1/-1">
      <div class="l">No trades yet</div>
      <div class="v">${st.launches || 0} ${(st.launches || 0) === 1 ? 'coin' : 'coins'} live</div>
      <div class="s">Holder rewards, volume and Fair Open fills fill in from the first swap — every figure on this page is read from chain, so none of them are seeded.</div></div>`;
  }
  return `<div class="stat"><div class="l">Holder rewards</div><div class="v gold">${fmtUsd(st.paidUsd || 0)}</div><div class="s">${fmtNum(st.payouts || 0)} reward payouts</div></div>
  <div class="stat"><div class="l">24h volume</div><div class="v">${fmtUsd(st.vol24Usd || 0)}</div><div class="s">${st.launches24 || 0} launches today</div></div>
  <div class="stat"><div class="l">Launches</div><div class="v">${st.launches || 0}</div><div class="s">${st.graduated || 0} graduated · ${st.fairOpensLive || 0} fair opens live</div></div>
  <div class="stat"><div class="l">Fair Open fills</div><div class="v">${fmtNum(st.fairOpenFills || 0)}</div><div class="s">uniform-price allocations, zero first bites</div></div>`;
}

// ============================================================ TOKEN PAGE
export async function token(root, mint) {
  root.innerHTML = '<div class="fade"><div class="skeleton" style="height:96px;margin-bottom:14px"></div><div class="tp"><div class="skeleton" style="height:440px"></div><div class="skeleton" style="height:440px"></div></div></div>';
  // ⛔ A COIN LINK IS THE ONE THAT GETS SHARED, SO IT IS THE ONE THAT GOES STALE — and a mint that
  // does not resolve was rendering the bare string "not found" in a box, with no context and no way
  // out, while an unknown ROUTE got a proper page with a button back. That is backwards: a wrong
  // /nonsense URL is a typo nobody sees, a wrong /t/<mint> is a link somebody followed in good faith
  // from a terminal, a group chat or a bookmark. Show which coin, and where to go instead.
  let d;
  try { d = await api(`/api/tokens/${mint}`); }
  catch (e) {
    const missing = /not found/i.test(String(e?.message || ''));
    root.innerHTML = `<div class="fade" style="text-align:center;padding:70px 20px">
      <div style="font-size:30px;margin-bottom:6px">${icon(missing ? 'block' : 'warn')}</div>
      <h1 style="font-size:28px">${missing ? 'No coin at this address' : 'This coin would not load'}</h1>
      <p class="muted" style="margin:10px auto 8px;max-width:460px;line-height:1.5">${missing
        ? 'Nothing has been launched here on REX Chain. The link may be old, may be for another launchpad, or may have a character missing.'
        : `Something went wrong fetching it — <span class="dim">${h(niceErr(e))}</span>`}</p>
      <div class="mono dim" style="font-size:12px;word-break:break-all;margin-bottom:20px">${h(mint)}</div>
      <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap">
        <a class="btn cta" href="/" data-link><span>Browse coins</span></a>
        ${missing ? `<a class="btn ghost" href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener">Look it up on chain</a>` : '<button class="btn ghost" id="coinRetry">Try again</button>'}
      </div></div>`;
    const rt = document.getElementById('coinRetry');
    if (rt) rt.onclick = () => { history.replaceState({}, '', location.pathname); dispatchEvent(new PopStateEvent('popstate')); };
    return () => {};
  }
  // Somebody shared a link: bind the visitor to them before anything else, so the first trade on
  // this page already counts. First touch wins, so calling it on every arrival is safe.
  const refCode = new URLSearchParams(location.search).get('r');
  if (refCode && S.me) {
    try { await api('/api/ref', { mint, code: refCode }); d = await api(`/api/tokens/${mint}`); } catch {}
  }
  let t = d.token, me = d.me; const usd = () => usdOf(t.quote); const ladder = d.ladder; const scale = d.convictionScale || 1;
  subscribe(mint);
  let side = new URLSearchParams(location.search).get('side') === 'sell' ? 'sell' : 'buy', slip = 100, chartMode = localStorage.getItem('forge_chart') || 'mcap', tf = '1m', tab = 'trades', chart = null;
  const isFO = () => t.status === 'fairopen' && t.fairOpenEnds > Date.now();
  const render = () => {
    root.innerHTML = `<div class="fade">
      ${t.creator === S.me?.wallet ? `<a class="launcherbar" href="/creator" data-link>${icon('gem')}<span><b>You launched this.</b> Your share of every swap is waiting on the creator dashboard.</span><i>Open →</i></a>` : ''}
      <div class="thead">${av(t, 'lg')}<div><h1>${h(t.name)}<span class="sym">$${h(t.symbol)}</span></h1><div class="row wrap" style="margin-top:8px">${badges(t)}<span class="muted" style="font-size:12px">created ${ago(t.createdAt)} ago by ${walletLink(t.creator, d.creatorName)}</span></div>
        <div class="row wrap camini" style="margin-top:8px">
          <code class="mono" title="${h(t.mint)}">${h(t.mint.slice(0, 6))}…${h(t.mint.slice(-6))}</code>
          <button class="btn sm" data-copy="${h(t.mint)}">Copy CA</button>
          <button class="btn sm" id="shareTop">Share</button>
          ${socialLinks(t)}${!socialLinks(t) && t.creator === S.me?.wallet ? `<a class="btn sm" href="/creator" data-link>${icon('link')}Add your links</a>` : ''}
        </div></div>
        <div class="price"><div class="big" id="pxBig">${fmtUsd(t.mcapUsd)}</div><div class="sub"><span id="pxSub">${fmtPrice(t.price)} ${t.quote} · ${fmtUsd(t.priceUsd)}</span> · <span id="pxChg" class="${t.chg1h == null ? 'dim' : t.chg1h >= 0 ? 'up' : 'down'}">${pct(t.chg1h)} 1h</span></div></div></div>
      ${t.hookProgram ? `<div class="warn" style="margin:12px 0">${icon('flame')}<div><b>This coin has transfer rules.</b>
        A separate program is called on every transfer and can refuse one — including a sell. It was set when the coin was minted and cannot be removed or changed.
        <span class="dim">Enforced by <span class="mono">${h(t.hookProgram)}</span>.</span></div></div>` : ''}
      <div class="kpis">
        <div class="k"><div class="l">Market cap</div><div class="v" id="kMcap">${fmtUsd(t.mcapUsd)}</div></div>
        <div class="k"><div class="l">24h volume</div><div class="v" id="kVol">${fmtUsd(t.vol24 * usd())}</div></div>
        <div class="k"><div class="l">Liquidity</div><div class="v" id="kLiq">${fmtUsd(t.liquidity * usd())}</div></div>
        <div class="k"><div class="l">Holders</div><div class="v" id="kHold">${t.holders}</div></div>
        <div class="k"><div class="l">Holder rewards</div><div class="v gold" id="kPaid">${fmtUsd(t.yieldPaid * usd())}</div></div>
        <div class="k"><div class="l">Trades</div><div class="v" id="kTrades">${t.trades}</div></div>
      </div>
      <div class="tp" style="margin-top:14px">
        <div class="stack">
          ${t.venue === 'dbc' && !t.trades ? `<div class="chart-wrap dbc">
            <iframe src="https://birdeye.so/tv-widget/${encodeURIComponent(t.mint)}?chain=solana&viewMode=pair&chartInterval=15&chartType=CANDLE&theme=dark&chartLeftToolbar=hide"
              title="${h(t.symbol)} chart" loading="lazy" referrerpolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
            <div class="chart-note">No swaps yet — our own chart starts with the first one. <a href="https://dexscreener.com/solana/${h(t.dbcPool || '')}" target="_blank" rel="noopener">DexScreener</a> already lists it.</div>
          </div>` : `<div class="chart-wrap"><div class="tools"><div class="tabs" id="tfs">${['1m', '5m', '15m', '1h'].map((x) => `<button data-tf="${x}" class="${x === tf ? 'on' : ''}">${x}</button>`).join('')}</div><div class="tabs" id="modes"><button data-m="mcap" class="${chartMode === 'mcap' ? 'on' : ''}">MCap $</button><button data-m="price" class="${chartMode === 'price' ? 'on' : ''}">Price ${h(t.quote)}</button></div></div><div id="chart"></div><div class="wm">REX Chain</div></div>`}
          <div class="panel pad">${curveBlock()}</div>
          <div class="panel pad"><div class="side-tabs" id="tabs">${[['trades', 'Trades'], ['holders', 'Holders'], ['social', 'Community'], ['chat', 'Chat'], ['payouts', 'Payouts'], ['info', 'Info']].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="tabBody"></div></div>
        </div>
        <div class="side">
          <div class="panel pad trade" id="tradePanel"></div>
          <div class="panel pad cv" id="convPanel"></div>
        </div>
      </div></div>`;
    mountTrade(); mountConv(); mountTab(); mountChartNow(); mountClaims(); mountShare(); mountRep(); mountPosts();
    // Copy buttons anywhere on the page, including the pair under the name.
    $$('[data-copy]', root).forEach((b) => b.onclick = () => { copyText(b.dataset.copy).then((ok) => toast(ok ? 'ok' : 'err', ok ? 'Copied' : 'Could not copy — select it and copy by hand')); });
    const sh = $('#shareTop', root);
    if (sh) sh.onclick = () => { $('#sharePanel', root)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    document.getElementById('mtrade')?.remove();
    const bar = document.createElement('div'); bar.id = 'mtrade'; bar.innerHTML = isFO() ? `<button class="btn cta" data-s="buy"><span>${icon('scales')}Commit to the Fair Open</span></button>` : `<button class="btn buy" data-s="buy">Buy $${h(t.symbol)}</button><button class="btn sell" data-s="sell">Sell</button>`;
    bar.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (!isFO()) { side = b.dataset.s; mountTrade(); } $('#tradePanel', root).scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    document.body.appendChild(bar);
    // The end of a launch, not an ordinary visit: scroll the trade panel up, focus the amount and
    // offer the contract address with one tap. Fires once — the flag is cleared before it is used,
    // so a refresh or a back-navigation is an ordinary visit again.
    let justLaunched = null;
    try { justLaunched = sessionStorage.getItem('rexJustLaunched'); if (justLaunched) sessionStorage.removeItem('rexJustLaunched'); } catch {}
    if (justLaunched === mint) {
      requestAnimationFrame(() => {
        $('#tradePanel', root)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const amt = $('#amt', root); if (amt) { amt.focus({ preventScroll: true }); }
        toast('gold', `<b>$${h(t.symbol)} is live.</b> Buy it below — or copy the contract address: <code class="mono">${short(mint)}</code>`, t.image);
        copyText(mint).then(
          (ok) => toast(ok ? 'ok' : 'err', ok ? 'Contract address copied to your clipboard' : 'Could not copy — select the address and copy it by hand'),
          () => {},
        );
      });
    }
    $$('#tfs button', root).forEach((b) => b.onclick = () => { tf = b.dataset.tf; $$('#tfs button', root).forEach((x) => x.classList.toggle('on', x === b)); loadCandles(); });
    $$('#modes button', root).forEach((b) => b.onclick = () => { chartMode = b.dataset.m; localStorage.setItem('forge_chart', chartMode); $$('#modes button', root).forEach((x) => x.classList.toggle('on', x === b)); mountChartNow(); });
    $$('#tabs button', root).forEach((b) => b.onclick = () => { tab = b.dataset.t; $$('#tabs button', root).forEach((x) => x.classList.toggle('on', x === b)); mountTab(); });
  };
  const foLine = () => t.fairOpenSecs > 0 && t.status !== 'fairopen' && t.fairOpenBidders > 0 ? `<div class="fo-line">${icon('scales')}Fair Open cleared <b>${t.fairOpenBidders} bidders</b> · ${fmtQ(t.fairOpenTotal, t.quote)} at one price · ${fmtPrice(t.fairOpenPrice)} ${t.quote}</div>` : '';
  const curveBlock = () => t.status === 'graduated'
    ? `<div class="row between"><div><h3>${icon('cap')}Graduated to the AMM</h3><div class="muted" style="font-size:12.5px;margin-top:4px">Raised ${fmtQ(t.raiseTarget, t.quote)} on the curve · LP burned · the same ${(t.taxBps / 100).toFixed(1)}% split keeps running</div></div><div class="num gold">Liquidity ${fmtUsd(t.liquidity * usd())}</div></div><div class="prog grad"><i style="width:100%"></i></div>${foLine()}`
    : !(t.raiseTarget > 0)
    // ⛔ A Meteora coin's graduation threshold lives on its POOL CONFIG, not in `raise_target` —
    // that column is only filled for coins on our own curve. Rendering it anyway printed
    // "Graduates at — REX ($0)" under a working pool, which reads as a broken launch.
    ? `<div class="row between"><div><h3>Bonding curve</h3><div class="muted" style="font-size:12.5px;margin-top:4px">${t.venue === 'dbc'
        ? 'Live on Meteora. It graduates to a locked AMM pool once the curve fills — the threshold is set on the pool itself.'
        : 'Graduation threshold not recorded for this coin.'}</div></div><div class="num">${(t.progress * 100 || 0).toFixed(2)}%</div></div><div class="prog"><i style="width:${(t.progress * 100 || 0).toFixed(2)}%"></i></div>${foLine()}`
    : `<div class="row between"><div><h3>Bonding curve</h3><div class="muted" style="font-size:12.5px;margin-top:4px">Graduates at ${fmtQ(t.raiseTarget, t.quote)} (${fmtUsd(t.raiseTarget * usd())}) · then migrates price-continuously to an AMM with burned LP</div></div><div class="num" id="curvePct">${(t.progress * 100).toFixed(2)}%</div></div><div class="prog"><i id="curveBar" style="width:${(t.progress * 100).toFixed(2)}%"></i></div><div class="prog-l"><span id="curveRaised">${fmtNum(t.raised)} ${t.quote} raised</span><span>${fmtNum(t.raiseTarget - t.raised)} ${t.quote} to go</span></div>${foLine()}`;

  // ---- chart
  let candleData = [];
  const fmtAxis = (v) => chartMode === 'mcap' ? fmtUsd(v) : fmtPrice(v);
  const mapC = (c) => { const k = chartMode === 'mcap' ? 1e9 * usd() : 1; return { time: c.time, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }; };
  async function loadCandles() { const r = await api(`/api/tokens/${mint}/candles?tf=${tf}`); candleData = r.candles; if (chart) { chart.setData(candleData.map(mapC)); chart.vol.setData(candleData.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(61,255,160,.35)' : 'rgba(255,77,109,.35)' }))); chart.chart.timeScale().fitContent(); } }
  function mountChartNow() {
    const el = $('#chart', root); if (!el) return;
    chart?.destroy(); chart = mountChart(el, { fmt: fmtAxis });
    // ⛔ THE ONLY HORIZONTAL WORTH DRAWING IS ONE WE KNOW EXACTLY.
    // This first marked the graduation price, derived as price x sqrt(target/raised) — a guess at
    // curve maths, and a confident wrong line on a price chart is worse than no line at all: people
    // trade against it. The Fair Open clearing price is STORED, exact, and the single most
    // REX-specific number a coin has: the one price at which every bidder, dev included, got in.
    if (t.fairOpenPrice > 0) { try { chart.setMarkPrice(t.fairOpenPrice, 'fair open'); } catch {} }
    loadCandles();
  }
  function liveCandle(c) { if (!chart || !c) return; const step = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 }[tf]; const b = Math.floor(c.ts / 1000 / step) * step; const last = candleData[candleData.length - 1];
    if (last && last.time === b) { last.high = Math.max(last.high, c.h); last.low = Math.min(last.low, c.l); last.close = c.c; if (tf === '1m') last.volume = c.v; else { last.volume += last._lts === c.ts ? c.v - (last._lv || 0) : c.v; } last._lv = c.v; last._lts = c.ts; }
    else candleData.push({ time: b, open: last ? last.close : c.o, high: c.h, low: c.l, close: c.c, volume: c.v, _lv: c.v, _lts: c.ts });
    const L = candleData[candleData.length - 1]; chart.update(mapC(L)); chart.vol.update({ time: L.time, value: L.volume, color: L.close >= L.open ? 'rgba(61,255,160,.35)' : 'rgba(255,77,109,.35)' }); }

  // ---- trade panel / fair open panel
  let quoteT = null, lastQuote = null;
  function mountTrade() {
    const el = $('#tradePanel', root); if (!el) return;
    if (isFO()) { el.classList.add('fo'); el.innerHTML = fairOpenPanel(); wireFO(); return; }
    el.classList.remove('fo');
    const bal = me ? (side === 'buy' ? me.quoteBalance : me.holding) : 0;
    // ⛔ "I CAN'T BUY THE COIN I JUST LAUNCHED" WAS USUALLY THIS, AND THE PANEL NEVER SAID IT.
    // A coin is priced in its quote asset, and thirty-four of the thirty-eight on offer are assets
    // nobody on this site is holding — ETH, ZEC, WIF, GLDx. The buy spends that asset, not SOL, so
    // a launcher with a full SOL wallet and no ETH got a button that failed with whatever the chain
    // said last. Name the reason, and make the fix one tap instead of a scavenger hunt.
    const noQuote = !!me && side === 'buy' && !(bal > 0);
    el.innerHTML = `<div class="switch"><button class="buy ${side === 'buy' ? 'on' : ''}" data-side="buy">Buy</button><button class="sell ${side === 'sell' ? 'on' : ''}" data-side="sell">Sell</button></div>
      <div class="amt"><div class="l"><span>${side === 'buy' ? 'You pay' : 'You sell'}</span><b id="useMax">Balance: ${me ? fmtNum(bal) : '—'} ${side === 'buy' ? t.quote : t.symbol}</b></div><div class="in"><input id="amt" inputmode="decimal" placeholder="0.0" autocomplete="off"><span class="asset"><i class="qd" style="width:8px;height:8px;border-radius:50%;background:${side === 'buy' ? quoteOf(t.quote).color : '#ffc24d'}"></i>${side === 'buy' ? t.quote : '$' + h(t.symbol)}</span></div></div>
      <div class="quick">${(side === 'buy' ? quickBuys(t.quote) : [['25%', .25], ['50%', .5], ['75%', .75], ['100%', 1]]).map(([l, v]) => `<button data-v="${v}" data-pct="${side === 'sell' || String(l).endsWith('%') ? 1 : 0}">${l}</button>`).join('')}</div>
      <div class="qout" id="qout"><div class="r big"><span>You receive</span><b id="qRecv">—</b></div><div class="r"><span>Avg price</span><b id="qPx">—</b></div><div class="r"><span>Price impact</span><b id="qImp">—</b></div>${t.taxBps ? `<div class="r"><span>Fee ${(t.taxBps / 100).toFixed(1)}% <span class="dim">(${(t.fees.holderBps / 100).toFixed(1)} holders${t.fees.creatorBps ? ' · ' + (t.fees.creatorBps / 100).toFixed(1) + ' dev' : ''}${t.fees.vaultBps ? ' · ' + (t.fees.vaultBps / 100).toFixed(1) + ' vault' : ''}${t.fees.burnBps ? ' · ' + (t.fees.burnBps / 100).toFixed(1) + ' burn' : ''})</span></span><b id="qTax" class="up">—</b></div>` : ''}<div class="r"><span class="dim">Platform fee</span><b class="dim">none</b></div></div>
      <div class="slip"><span>Slippage</span>${[100, 300, 500].map((b) => `<button data-b="${b}" class="${slip === b ? 'on' : ''}">${b / 100}%</button>`).join('')}<input id="slipIn" value="${slip / 100}" aria-label="custom slippage">%</div>
      ${noQuote ? `<div class="needq">${icon('warn')}<div><b>You hold no ${h(t.quote)}.</b> This coin is priced in ${h(t.quote)}, so that is what a buy spends — not SOL. Swap into some first and come back.</div></div>` : ''}
      <button class="btn go ${side}" id="go">${!me ? 'Connect wallet to trade' : noQuote ? `Get ${h(t.quote)} to buy` : side === 'buy' ? `Buy $${h(t.symbol)}` : `Sell $${h(t.symbol)}`}</button>
      ${side === 'buy' ? `<button class="btn ghost sm" id="toBasket" style="width:100%;margin-top:8px"><span>Add to basket</span></button>` : ''}
      <div class="note">${t.status === 'graduated' ? 'Trading on the burned-LP AMM.' : 'On the bonding curve.'} ${(t.taxBps / 100).toFixed(1)}% total, split across the buckets and settled every epoch — there is no platform fee on top. A send pays nothing.</div>`;
    $$('.switch button', el).forEach((b) => b.onclick = () => { side = b.dataset.side; mountTrade(); });
    const amt = $('#amt', el);
    $$('.quick button', el).forEach((b) => b.onclick = () => { const v = Number(b.dataset.v); amt.value = b.dataset.pct === '1' ? String(+(bal * v).toFixed(v === 1 ? 6 : 4)) : String(v); amt.dispatchEvent(new Event('input')); });
    $('#useMax', el).onclick = () => { amt.value = String(bal); amt.dispatchEvent(new Event('input')); };
    $$('.slip button', el).forEach((b) => b.onclick = () => { slip = Number(b.dataset.b); $('#slipIn', el).value = slip / 100; $$('.slip button', el).forEach((x) => x.classList.toggle('on', x === b)); });
    $('#slipIn', el).oninput = (e) => { const v = Number(e.target.value); if (v > 0) { slip = Math.round(v * 100); $$('.slip button', el).forEach((x) => x.classList.toggle('on', Number(x.dataset.b) === slip)); } };
    amt.oninput = () => { clearTimeout(quoteT); quoteT = setTimeout(getQuote, 120); };
    amt.onkeydown = (e) => { if (e.key === 'Enter') $('#go', el).click(); };
    const tb = $('#toBasket', el);
    if (tb) tb.onclick = (e) => {
      e.preventDefault();
      basketAdd({ mint: t.mint, symbol: t.symbol, quote: t.quote, venue: t.venue });
    };
    $('#go', el).onclick = async () => {
      if (!me) { await connectWallet(); return; }
      if (noQuote) { const qm = quoteOf(t.quote)?.mint; history.pushState({}, '', qm ? `/swap?to=${encodeURIComponent(qm)}` : '/swap'); dispatchEvent(new PopStateEvent('popstate')); return; }
      await doTrade();
    };
    if (matchMedia('(hover:hover) and (pointer:fine)').matches) amt.focus();
  }
  /**
   * ⛔ A QUICK-BUY BUTTON IS A PROMISE THAT THE AMOUNT IS SENSIBLE, AND THESE WERE NOT.
   *
   * There were four hand-written ladders — SOL, USDC, REX, and `10K / 50K / 100K / 500K` for
   * "everything else". Everything else is thirty-four of our thirty-eight quote assets. A coin
   * paired against ETH therefore offered a first buy of TEN THOUSAND ETH, about twenty-five million
   * dollars, on the cheapest button; all four were unaffordable, so every tap ended in a failure.
   * That is what "after launching can't buy on platform" was: Julz launched $VEGETA against ETH and
   * every preset the panel gave him was nonsense.
   *
   * The rungs are money, so they are derived from money — roughly $10 / $50 / $100 / $500 of
   * whatever the quote happens to be worth, snapped to a round number so the button still reads
   * like something a person would type. Checked against the old hand-written SOL ladder, this
   * reproduces it exactly, which is the nicest evidence that the shape is right.
   */
  const niceAmt = (x) => { if (!(x > 0) || !Number.isFinite(x)) return 0; const mag = 10 ** Math.floor(Math.log10(x)); const n = x / mag; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag; };
  const rungLabel = (v) => v >= 1e9 ? `${+(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(0)}K` : String(+v.toPrecision(3));
  const quickBuys = (q) => {
    const meta = quoteOf(q);
    // ⛔ ANY DOLLAR FIGURE BEATS THE FIXED LADDER — INCLUDING A STALE ONE, AND THIS IS THE WHOLE
    // POINT. The first version of this refused to size a buy off a price the aggregator had not
    // confirmed, which sounds careful and is exactly backwards: when nothing is confirmed, which is
    // precisely the state production was in, it fell back to `10K / 50K / 100K / 500K` and the bug
    // was still there. A seed price that is twice out makes a $50 button a $100 button. The fixed
    // ladder makes it a $25,000,000 button. The errors are not in the same universe, and only one
    // of them stops somebody buying.
    //
    // The fixed rungs are kept for the one case where there is genuinely no figure at all.
    const usd = Number(meta?.usd) || 0;
    if (!(usd > 0)) return q === 'SOL' ? [['0.1', .1], ['0.5', .5], ['1', 1], ['5', 5]] : q === 'USDC' ? [['10', 10], ['50', 50], ['100', 100], ['500', 500]] : q === 'REX' ? [['50K', 5e4], ['250K', 2.5e5], ['1M', 1e6], ['5M', 5e6]] : [['10K', 1e4], ['50K', 5e4], ['100K', 1e5], ['500K', 5e5]];
    return [10, 50, 100, 500].map((d) => { const v = niceAmt(d / usd); return [rungLabel(v), v]; });
  };
  /** Decimals on each leg. Our DBC mints are 6-decimal SPL; the quote asset is whatever it is, and
   *  SOL is 9 — mixing those up is a factor-of-a-thousand error in a buy box. */
  const legDecimals = () => { const qd = quoteOf(t.quote)?.decimals ?? 6; return { spend: side === 'buy' ? qd : 6, recv: side === 'buy' ? 6 : qd, quote: qd }; };
  /**
   * A coin on the Meteora venue is priced by Meteora's curve, not ours, so `/api/quote` (which
   * reads OUR pool row) would quote a pool that does not exist and show numbers that no trade can
   * honour. Quote the real pool instead.
   */
  async function getQuoteDbc(el, v) {
    const d = legDecimals();
    // ⛔ ROUTE BY VENUE. A LaunchLab coin priced against Meteora's curve is a number no trade can
    // honour — the same mistake as quoting our own pool row for a Meteora coin, one venue along.
    const path = t.venue === 'launchlab' ? '/api/chain/ll/quote' : '/api/chain/dbc/quote';
    const r = await api(path, { mint, amountIn: Math.floor(v * 10 ** d.spend), sell: side === 'sell', slippageBps: slip });
    // ⛔ The two venues answer in different units: Meteora in raw base units, LaunchLab already in
    // whole tokens. Dividing LaunchLab's answer again is a factor of a million on the screen.
    const ll = t.venue === 'launchlab';
    const out = ll ? Number(r.out) : Number(r.out) / 10 ** d.recv;
    const minOut = ll ? Number(r.outMin) : Number(r.minOut) / 10 ** d.recv;
    const fee = ll ? Number(r.fee) : Number(r.fee) / 10 ** d.quote;
    // minOut comes back already slippage-adjusted by the SDK — re-applying slip would double it.
    lastQuote = { dbc: true, ll, out, minOut, fee, impact: r.impact ?? (r.priceImpactPct != null ? r.priceImpactPct / 100 : null) };
    $('#qRecv', el).textContent = side === 'buy' ? `${fmtNum(out)} $${t.symbol}` : `${fmtNum(out)} ${t.quote}`;
    $('#qPx', el).textContent = `${fmtPrice(side === 'buy' ? v / (out || 1) : (out || 0) / v)} ${t.quote}`;
    const imp = $('#qImp', el);
    // ⛔ A DASH MEANS "NOT KNOWN", A NUMBER MEANS "MEASURED". The DBC quote does not return impact,
    // and inventing one from our own curve's maths would be a confident lie about a different pool.
    if (imp) { imp.textContent = r.impact == null ? '—' : pct(r.impact, 2); imp.className = r.impact != null && Math.abs(r.impact) > 0.1 ? 'down' : ''; }
    $('#qFee', el).textContent = `${fmtNum(fee)} ${t.quote}`;
    const tx = $('#qTax', el); if (tx) tx.textContent = 'included in fee';
  }
  async function getQuote() {
    const el = $('#tradePanel', root); const v = Number($('#amt', el)?.value); if (!(v > 0)) { lastQuote = null; ['qRecv', 'qPx', 'qImp', 'qFee', 'qTax'].forEach((id) => { const x = $('#' + id, el); if (x) x.textContent = '—'; }); return; }
    if (t.venue === 'dbc') { try { return await getQuoteDbc(el, v); } catch (e) { lastQuote = null; $('#qRecv', el).textContent = niceErr(e); return; } }
    try { const { quote: q } = await api('/api/quote', { mint, side, amount: v }); lastQuote = q;
      $('#qRecv', el).textContent = side === 'buy' ? `${fmtNum(q.tokensOut)} $${t.symbol}` : `${fmtNum(q.quoteOut)} ${t.quote}${q.clamped ? ' (max: your balance)' : ''}`;
      $('#qPx', el).textContent = `${fmtPrice(q.avgPrice)} ${t.quote}`; const imp = $('#qImp', el); imp.textContent = pct(q.impact, 2); imp.className = Math.abs(q.impact) > 0.1 ? 'down' : '';
      $('#qFee', el).textContent = `${fmtNum(q.fee)} ${t.quote}`; const tx = $('#qTax', el); if (tx) tx.textContent = `${fmtNum(q.tax)} ${t.quote}`;
      // textContent, not innerHTML, is what makes the quote line safe to write from a server
      // response — so the icon is appended as markup only here, where the whole string is ours.
      if (q.graduates) $('#qRecv', el).innerHTML = h($('#qRecv', el).textContent) + ` ${icon('cap')}(clears the curve)`;
    } catch (e) { $('#qRecv', el).textContent = niceErr(e); }
  }
  const baseUnits = (v, dec = 6) => Math.floor(Number(v) * 10 ** dec);
  async function doTradeOnChain(v) {
    const go = $('#go', $('#tradePanel', root));
    const stage = (s) => { go.textContent = { building: 'Building…', checking: 'Checking…', signing: 'Confirm in your wallet…', sending: 'Sending…', done: 'Done' }[s] || s; };
    const q = lastQuote;
    // Meteora's program owns this coin's curve, so our own buy/sell instructions cannot touch it.
    // Routing by venue is the whole reason `venue` is sent to the client.
    const r = t.venue === 'dbc'
      ? await (async () => {
          const d = legDecimals();
          const what = t.venue === 'launchlab'
            ? (side === 'buy' ? 'll-buy' : 'll-sell')
            : (side === 'buy' ? 'dbc-buy' : 'dbc-sell');
          return CHAIN.act(what, {
            mint, amountIn: Math.floor(v * 10 ** d.spend),
            // Already slippage-adjusted by the SDK. A floor of 0 would mean "accept any price",
            // which on a thin brand-new curve is how a first buyer gets emptied.
            minimumAmountOut: q?.ll ? 0 : (q?.dbc ? Math.floor(q.minOut * 10 ** d.recv) : 0),
            slippageBps: slip,
          }, { onStage: stage });
        })()
      : side === 'buy'
      ? await CHAIN.act('buy', { mint, quoteIn: baseUnits(v), minTokensOut: q ? Math.floor(q.tokensOut * (1 - slip / 10_000) * 1e6) : 0 }, { onStage: stage })
      : await CHAIN.act('sell', { mint, tokensIn: baseUnits(v), minQuoteOut: q ? Math.floor(q.quoteOut * (1 - slip / 10_000) * 1e6) : 0 }, { onStage: stage });
    toast('ok', `${side === 'buy' ? 'Bought' : 'Sold'} on chain · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">view tx</a>`, t.image);
    const fresh = await api(`/api/tokens/${mint}`); t = fresh.token; me = fresh.me; mountTrade(); mountConv(); updateHead();
  }
  async function doTrade() {
    const el = $('#tradePanel', root); const v = Number($('#amt', el).value); if (!(v > 0)) return toast('err', 'Enter an amount');
    // A buy bigger than the wallet used to be refused by the chain, three signature prompts later,
    // with whatever wording the program happened to use. Catch it here and say the number.
    const have = side === 'buy' ? me?.quoteBalance : me?.holding;
    if (have != null && v > have) return toast('err', `You have ${fmtNum(have)} ${side === 'buy' ? h(t.quote) : '$' + h(t.symbol)} — that buy needs ${fmtNum(v)}`);
    const go = $('#go', el); go.disabled = true; go.textContent = 'Working…';
    if (CHAIN.on()) {
      try { await doTradeOnChain(v); } catch (e) { toast('err', niceErr(e)); }
      go.disabled = false; mountTrade(); return;
    }
    try { const r = await api('/api/trade', { mint, side, amount: v, slippageBps: slip }); me = r.me; t = { ...t, ...r.token }; S.me && (S.me.balances = me.balances); bus.emit('auth', S.me);
      toast('ok', side === 'buy' ? `Bought <b>${fmtNum(r.trade.tokens)} $${h(t.symbol)}</b> for ${fmtNum(r.trade.quote)} ${t.quote}` : `Sold <b>${fmtNum(r.trade.tokens)} $${h(t.symbol)}</b> for ${fmtNum(r.trade.quote)} ${t.quote}`, t.image);
      if (r.result.graduates) toast('gold', `${icon('cap')}<b>$${h(t.symbol)}</b> just graduated — you cleared the curve.`, t.image);
      mountTrade(); mountConv(); updateHead(); }
    catch (e) { toast('err', niceErr(e)); go.disabled = false; go.textContent = side === 'buy' ? `Buy $${t.symbol}` : `Sell $${t.symbol}`; }
  }
  function fairOpenPanel() {
    const left = t.fairOpenEnds - Date.now(); const total = t.fairOpenSecs * 1000;
    return `<div class="h">${ring(left, total, 'lg')}<div><div class="t">${icon('scales')}Fair Open in progress</div><div class="s">Sealed window. Every commitment inside — including the dev's — clears at <b>one uniform price</b>, allocated pro-rata. Nobody can snipe block 0.</div></div></div>
      <div class="g"><div class="b"><div class="l">Committed so far</div><div class="v" id="foTotal">${fmtQ(t.fairOpenTotal, t.quote)}</div></div><div class="b"><div class="l">Bidders</div><div class="v" id="foBidders">${t.fairOpenBidders}</div></div><div class="b"><div class="l">Your commitment</div><div class="v gold" id="foMine">${me ? fmtQ(me.bid, t.quote) : '—'}</div></div><div class="b"><div class="l">Est. opening mcap</div><div class="v" id="foMcap">${fmtUsd(estOpenMcap())}</div></div></div>
      <div class="amt"><div class="l"><span>Commit</span><b id="foMax">Balance: ${me ? fmtNum(me.quoteBalance) : '—'} ${t.quote}</b></div><div class="in"><input id="foAmt" inputmode="decimal" placeholder="0.0"><span class="asset"><i class="qd" style="width:8px;height:8px;border-radius:50%;background:${quoteOf(t.quote).color}"></i>${t.quote}</span></div></div>
      <div class="quick">${quickBuys(t.quote).map(([l, v]) => `<button data-v="${v}">${l}</button>`).join('')}</div>
      <button class="btn go cta" id="foGo">${me ? 'Commit to the Fair Open' : 'Connect wallet to commit'}</button>
      ${me && me.bid > 0 ? '<button class="btn ghost" id="foCancel" style="width:100%;margin-top:8px">Withdraw my commitment</button>' : ''}
      <div class="note">Your quote is escrowed until the window closes, then converted at the clearing price. Withdraw any time before the bell.</div>`;
  }
  function estOpenMcap() { // uniform-price estimate: one lump buy of the committed total
    const q = t.fairOpenTotal * (1 - 0.01 - t.taxBps / 1e4); const vq = 30 * t.raiseTarget / 85.0054, vt = 1.073e9, k = vq * vt; const out = vt - k / (vq + q); const px = q > 0 ? q / out : vq / vt; return px * 1e9 * usd();
  }
  function wireFO() {
    const el = $('#tradePanel', root); const inp = $('#foAmt', el);
    $$('.quick button', el).forEach((b) => b.onclick = () => { inp.value = b.dataset.v; });
    $('#foMax', el).onclick = () => { if (me) inp.value = String(me.quoteBalance); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') $('#foGo', el).click(); };
    $('#foGo', el).onclick = async () => { if (!me) return connectWallet(); const v = Number(inp.value); if (!(v > 0)) return toast('err', 'Enter an amount');
      const btn = $('#foGo', el); btn.disabled = true;
      try {
        if (CHAIN.on()) {
          const r = await CHAIN.act('commit', { mint, amount: Math.floor(v * 1e6) }, { onStage: (st) => { btn.textContent = st === 'signing' ? 'Confirm in your wallet…' : st === 'sending' ? 'Sending…' : 'Working…'; } });
          toast('ok', `Committed <b>${fmtNum(v)} ${t.quote}</b> on chain · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">view tx</a>`, t.image);
          const fresh = await api(`/api/tokens/${mint}`); t = fresh.token; me = fresh.me;
        } else { const r = await api('/api/fairopen/bid', { mint, amount: v }); me = r.me; t.fairOpenTotal = r.total; t.fairOpenBidders = r.bidders; toast('ok', `Committed <b>${fmtNum(v)} ${t.quote}</b> to the Fair Open`, t.image); }
        mountTrade();
      } catch (e) { toast('err', niceErr(e)); btn.disabled = false; btn.textContent = 'Commit to the Fair Open'; } };
    const c = $('#foCancel', el); if (c) c.onclick = async () => { try { const r = await api('/api/fairopen/cancel', { mint }); me = r.me; t.fairOpenTotal = r.total; t.fairOpenBidders = r.bidders; toast('ok', 'Commitment withdrawn'); mountTrade(); } catch (e) { toast('err', niceErr(e)); } };
  }

  // ---- conviction panel
  function mountConv() {
    const el = $('#convPanel', root); if (!el) return;
    const left = S.nextEpochAt - Date.now(); const pos = me && me.holding > 1 ? me : null;
    const fe = t.fees || {}, bk = t.buckets || {};
    const bucket = (label, bps, pot, paid, note) => bps > 0 ? `<div class="b"><div class="l">${label} ${(bps / 100).toFixed(1)}%</div><div class="v">${fmtQ(pot || 0, t.quote)}</div><div class="hint">${paid > 0 ? fmtQ(paid, t.quote) + ' paid · ' : ''}${note}</div></div>` : '';
    // Which rule this coin actually pays by. It used to say "pro-rata to your balance" unconditionally,
    // which is only true of one of the two modes — and the wrong half of that sentence is precisely
    // what a holder would act on.
    const dh = (t.rewardMode || 'hold') === 'hold';
    // ⛔ WHAT A HOLDER IS ACTUALLY HANDED. This said "in ${t.quote}" unconditionally, which stops
    // being true the moment a coin pays a basket — and the asset someone is paid in is the single
    // thing they are most likely to act on. Name the real legs, with their shares.
    const basket = Array.isArray(t.payoutAssets) && t.payoutAssets.length ? t.payoutAssets : null;
    const paidIn = basket
      ? basket.map((l) => `<b>$${h(l.asset)}</b>&nbsp;${(l.bps / 100).toFixed(0)}%`).join(' · ')
      : h(t.quote);
    el.innerHTML = `<div class="row between"><div><h3>${icon('rex')}Holder rewards</h3><div class="muted" style="font-size:12px;margin-top:3px">${(fe.holderBps / 100).toFixed(1)}% of every <b>swap</b>, paid in ${paidIn} — ${dh
        ? 'split by balance <b>×</b> how long you have held, up to <b>3x</b>'
        : 'pro-rata to your balance at the snapshot'}. Sends are free.</div>
        <div class="chip" style="margin-top:6px;height:20px;font-size:10.5px">${dh ? icon('gem') + 'Diamond Hands' : icon('scales') + 'Simple'}</div>${basket ? `<div class="chip" style="margin-top:6px;height:20px;font-size:10.5px">${icon('gem')}Basket of ${basket.length}</div>` : ''}</div>${ring(left, S.epochMs)}</div>
      <div class="fo g" style="border:0;background:none;padding:0"><div class="b"><div class="l">Pool this epoch</div><div class="v gold" id="cvPool">${fmtQ((t.yieldPool || 0) + (t.pendingYield || 0), t.quote)}</div><div class="hint" id="cvPoolUsd">${fmtUsd(t.yieldPool * usd())}</div></div><div class="b"><div class="l">Paid so far</div><div class="v" id="cvPaid">${fmtUsd((t.yieldPaid || 0) * usd())}</div><div class="hint">${t.yieldOwed > 0 ? `${fmtQ(t.yieldOwed, t.quote)} waiting to go out · ` : ''}${t.yieldEpochs} epochs</div></div></div>
      ${pos ? `<div class="row between" style="margin-top:12px"><div><div class="hint">${dh ? 'Your weighted share' : 'Your balance share'}</div><div class="num">${((pos.share || 0) * 100).toFixed(2)}%${pos.belowFloor ? ' <span class="chip" style="height:18px;font-size:10px">under the $20 floor</span>' : ''}</div></div><div style="text-align:right"><div class="hint">Your est. payout</div><div class="num gold" id="cvShare">${fmtQ(t.yieldPool * (pos.share || 0), t.quote)}</div>${basket ? `<div class="hint" style="font-size:10.5px">value, paid out across ${basket.length} assets</div>` : ''}</div></div>`
             : `<div class="hint" style="margin-top:10px">${me ? `Hold at least $${20} worth to be in the next epoch.` : 'Connect a wallet and hold to earn.'}</div>`}
      ${t.reward?.allBelowFloor && t.yieldPool > 0 ? `<div class="note gold">Every position is currently under the $${t.reward.floorUsd} floor (${fmtQ(t.reward.floorQuote, t.quote)} of $${h(t.symbol)}), so this pool rolls into the next epoch rather than paying dust.</div>` : ''}
      ${(fe.creatorBps || fe.vaultBps || fe.burnBps) ? `<div class="hint" style="margin:14px 0 6px">The other buckets, collected and waiting for this epoch</div>
      <div class="fo g" style="border:0;background:none;padding:0">
        ${bucket('Creator', fe.creatorBps, bk.creatorPot, bk.creatorPaid, 'to the dev, in ' + h(t.quote))}
        ${bucket('Vault', fe.vaultBps, bk.vaultPot, bk.vaultPaid, '70% LP / 30% bid')}
        ${bucket('Burn', fe.burnBps, bk.burnPot, bk.burnPaid, bk.burnedTokens > 0 ? fmtNum(bk.burnedTokens) + ' burned' : 'buys &amp; burns')}
      </div>` : ''}
      ${fe.vaultBps ? `<div class="vaultaddr"><span class="hint">Vault address (public from the first deposit, no redeem)</span><code class="mono">${bk.vaultAddress}</code><button class="btn sm" data-copy="${bk.vaultAddress}">copy</button></div>` : ''}
      ${t.guard ? `<div class="note gold">Launch guard live for ${t.guard.secsLeft}s: ${t.guard.capPct ? `${t.guard.capPct.toFixed(2)}% per wallet` : ''}${t.guard.capPct && t.guard.decayBps ? ' · ' : ''}${t.guard.decayBps ? `${(t.guard.decayBps / 100).toFixed(2)}% decaying fee to the ${t.guard.to}` : ''}</div>` : ''}
      <div id="claims"></div>
      <div id="sharePanel"></div>
      <div id="repPanel"></div>
      <div class="note">REX takes ${((fe.rexBps || 0) / 100).toFixed(0)}% <b>of the rewards bucket only</b> — never the vault, the burn or the creator's cut, and never as a fifth fee. That share falls to 10% as verified volume grows.</div>`;
  }
  /**
   * Share & earn. Every wallet gets one link per token; buys made through it are credited to them
   * for as long as the token trades, and paid out of the creator's own cut at each epoch.
   */
  /** The creator's public record, and the milestones this token has crossed. */
  function mountRep() {
    const box = $('#repPanel', root); if (!box) return;
    const ch = d.creatorHistory || {}, ms = d.milestones || [];
    const rate = ch.launches ? Math.round((ch.graduated / ch.launches) * 100) : 0;
    box.innerHTML = `<div class="repbox">
      <div class="hint">Who launched this</div>
      <div class="row between" style="margin-top:4px"><div>${walletLink(t.creator, d.creatorName)}</div>
        <div class="dim" style="font-size:11.5px">${ch.launches || 0} launch${ch.launches === 1 ? '' : 'es'} · ${ch.graduated || 0} graduated${ch.launches > 1 ? ` (${rate}%)` : ''}</div></div>
      <div class="replist">
        <span>Holder rewards<b class="gold">${fmtUsd(ch.paidUsd || 0)}</b></span>
        <span>Volume<b>${fmtUsd(ch.volumeUsd || 0)}</b></span>
        <span>First launch<b>${ch.firstLaunch ? ago(ch.firstLaunch) + ' ago' : '—'}</b></span>
      </div>
      ${ms.length ? `<div class="hint" style="margin-top:10px">Milestones</div><div class="marks">${ms.map((x) => `<span class="mark" title="${ago(x.ts)} ago">${h(x.label)}</span>`).join('')}</div>` : ''}
    </div>`;
  }

  function mountShare() {
    const box = $('#sharePanel', root); if (!box) return;
    const sh = t.social || {};
    if (!sh.refShareBps) {
      // No creator cut to pay a referrer out of — but a link to send someone is not a reward
      // programme, and a coin you cannot share is a coin that does not spread.
      const plain = `${location.origin}/t/${t.mint}`;
      const post0 = `$${t.symbol} on @tryrexfun\n\n${plain}`;
      box.innerHTML = `<div class="sharebox"><div class="row between"><div><b>${icon('link')}Share $${h(t.symbol)}</b>
        <div class="hint">Send this to anyone. ${t.creator === S.me?.wallet
          ? 'Share &amp; earn is off for this coin — turn it on below and every holder has a reason to spread it.'
          : 'Share &amp; earn is off for this coin, so there is nothing to pay a sharer out of yet.'}</div></div></div>
        ${t.creator === S.me?.wallet ? `<div class="setshare" style="margin-top:10px">
          <div class="hint">How much of YOUR OWN cut goes to whoever brings the volume</div>
          <div class="opts" id="setShare">${[0, 2500, 5000, 7500, 10000].map((v) => `<button data-v="${v}" class="${v === (sh.refShareBps || 0) ? 'on' : ''}">${v ? v / 100 + '%' : 'Off'}</button>`).join('')}</div></div>` : ''}
        <div class="reflink"><code>${h(plain)}</code><button class="btn sm" data-copy="${h(plain)}">copy</button></div>
        <div class="row" style="margin-top:8px;justify-content:flex-end">
          <a class="btn sm cta" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=${encodeURIComponent(post0)}">Post on 𝕏</a></div></div>`;
      $$('[data-copy]', box).forEach((b) => b.onclick = () => { copyText(b.dataset.copy).then((ok) => toast(ok ? 'ok' : 'err', ok ? 'Copied' : 'Could not copy — select it and copy by hand')); });
      // ⛔ Coins launched before the setting was stored are stuck at zero, and the number they
      // originally picked was never written down anywhere, so it cannot be restored for them.
      $$('#setShare button', box).forEach((b) => b.onclick = async () => {
        try {
          const r = await api('/api/chain/creator/share', { wallet: S.me.wallet, mint: t.mint, refShareBps: Number(b.dataset.v) });
          t.social = { ...(t.social || {}), refShareBps: r.refShareBps, refShareOfTradeBps: r.refShareOfTradeBps };
          toast('ok', r.refShareBps ? `Sharers now earn ${(r.refShareOfTradeBps / 100).toFixed(3)}% of every trade they bring` : 'Share & earn turned off');
          mountShare();
        } catch (e) { toast('err', niceErr(e)); }
      });
      return;
    }
    const cut = (sh.refShareOfTradeBps / 100).toFixed(3);
    if (!S.me || !d.ref) {
      box.innerHTML = `<div class="sharebox"><div class="row between"><div><b>${icon('link')}Share &amp; earn ${cut}%</b><div class="hint">of every trade you bring, paid in ${h(t.quote)} at each epoch</div></div><button class="btn sm" id="shConnect">Connect to get your link</button></div></div>`;
      const b = $('#shConnect', root); if (b) b.onclick = () => connectWallet();
      return;
    }
    const link = `${location.origin}/t/${t.mint}?r=${d.ref.code}`;
    const post = `I'm holding $${t.symbol} on @tryrexfun.\n\n${sh.refShareBps ? `Buy through my link and I earn ${cut}% of it — costs you nothing.\n\n` : ''}${link}`;
    box.innerHTML = `<div class="sharebox">
      <div class="row between"><div><b>${icon('link')}Share &amp; earn ${cut}%</b><div class="hint">of every trade you bring — paid out of the creator's own cut, not the holders'</div></div>
        <div class="num gold">${d.ref.earned > 0 ? fmtQ(d.ref.earned, t.quote) : '—'}</div></div>
      <div class="reflink"><code>${h(link)}</code><button class="btn sm" data-copy="${h(link)}">copy</button></div>
      <div class="row between" style="margin-top:8px">
        <div class="hint">You brought <b>${d.ref.brought}</b> ${d.ref.brought === 1 ? 'buyer' : 'buyers'} · ${fmtQ(d.ref.volume, t.quote)} of volume</div>
        <a class="btn sm cta" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=${encodeURIComponent(post)}">Post on 𝕏</a>
      </div>
      ${d.ref.pending ? `<div class="hint" style="margin-top:6px">${d.ref.pending} referral${d.ref.pending === 1 ? '' : 's'} pending — a referral counts once they have traded and are still holding.</div>` : ''}
      ${S.gate?.refHoldUsd > 0 ? `<div class="hint" style="margin-top:4px">Earning needs <b>$${fmtNum(S.gate.refHoldUsd)} of $REX</b> held${S.me?.rexUsd != null ? ` — you hold ${fmtUsd(S.me.rexUsd)}` : ''}.</div>` : ''}
      ${d.ref.broughtBy ? `<div class="hint" style="margin-top:6px">You were brought here by ${walletLink(d.ref.broughtBy)} — they earn on what you trade.</div>` : ''}
    </div>`;
  }

  /** The creator's own update feed, and the box to post to it. */
  function mountPosts() {
    const box = $('#postsPanel', root); if (!box) return;
    const mine = S.me && S.me.wallet === t.creator;
    const list = (d.posts || []).map((p2) => `<div class="post"><div class="row between"><b>${h(p2.who || short(p2.wallet))}</b><span class="dim">${ago(p2.ts)} ago</span></div><div>${h(p2.text)}</div></div>`).join('');
    box.innerHTML = `<div class="row between"><h3>${icon('megaphone')}Updates from the creator</h3></div>
      ${mine ? `<div class="amt" style="margin-top:8px"><div class="in"><input id="postText" maxlength="500" placeholder="Tell your holders what just shipped…"></div></div><button class="btn sm cta" id="postBtn" style="margin-top:6px">Post update</button>` : ''}
      <div class="posts">${list || '<div class="hint">No updates yet.</div>'}</div>`;
    const b = $('#postBtn', root);
    if (b) b.onclick = async () => {
      const el = $('#postText', root); const text = el.value.trim(); if (text.length < 2) return;
      try { await api('/api/posts', { mint, text }); el.value = ''; d = await api(`/api/tokens/${mint}`); mountPosts(); toast('ok', 'Update posted'); }
      catch (e) { toast('err', niceErr(e)); }
    };
  }

  /**
   * Callouts on this coin.
   *
   * ⛔ WHAT MAKES A CALL WORTH READING IS THAT THE ENTRY WAS FIXED BEFORE THE ANSWER WAS KNOWN.
   * Every row shows the market cap it was called at and the best multiple since, both derived from
   * the frozen price and the candles — never anything the caller can edit afterwards.
   */
  async function mountCallouts() {
    const box = $('#calloutPanel', root); if (!box) return;
    const draw = (d2) => {
      const rows = (d2.callouts || []).map((c) => `<div class="co">
        <div class="co-top">${walletLink(c.wallet, null)}<span class="dim">${ago(c.ts)} ago</span>
          <span class="co-x ${c.peakX == null ? 'dim' : c.peakX >= 1.5 ? 'up' : c.peakX < 0.8 ? 'down' : ''}">${c.peakX == null ? '—' : c.peakX.toFixed(2) + 'x'}</span></div>
        ${c.text ? `<div class="co-t">${h(c.text)}</div>` : ''}
        <div class="co-b"><span>called at ${fmtUsd(c.mcapAt)}</span>${c.xUrl ? ` · <a href="${h(c.xUrl)}" target="_blank" rel="noopener nofollow">the post</a>` : ''}</div>
      </div>`).join('');
      const held = (me?.holding || 0) > 0;
      box.innerHTML = `<div class="row between"><h3>${icon('megaphone')}Callouts</h3><span class="dim" style="font-size:11.5px">${d2.total || 0} on this coin</span></div>
        <p class="hint" style="margin:6px 0 0">Call it in public and your referral link for $${h(t.symbol)} rides along — anything bought through it is attributed to you and paid out of this coin's referral share.</p>
        ${S.me ? (held
          ? `<div class="amt" style="margin-top:8px"><div class="in"><input id="coText" maxlength="280" placeholder="Why $${h(t.symbol)}, in one line…"></div></div>
             <div class="amt" style="margin-top:6px"><div class="in"><input id="coX" maxlength="300" inputmode="url" placeholder="Link to your post on X (optional)"></div></div>
             <button class="btn sm cta" id="coBtn" style="margin-top:6px">Call it</button>`
          : `<div class="hint" style="margin-top:8px">Buy some $${h(t.symbol)} to call it — a callout has to carry your own position.</div>`) : ''}
        <div class="colist">${rows || '<div class="hint">Nobody has called this one yet.</div>'}</div>`;
      const b = $('#coBtn', root);
      if (b) b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await api('/api/callouts', { mint, text: $('#coText', root).value.trim(), xUrl: $('#coX', root).value.trim() || null });
          toast('gold', `Called <b>$${h(t.symbol)}</b> at ${fmtUsd(r.mcapAt)} — it is on your record now`, t.image);
          load();
        } catch (e) { toast('err', niceErr(e)); b.disabled = false; }
      };
    };
    const load = async () => { try { draw(await api(`/api/callouts?mint=${mint}`)); } catch { box.innerHTML = ''; } };
    load();
  }

  async function mountClaims() {
    const box = $('#claims', root); if (!box || !CHAIN.on() || !S.me) return;
    try {
      const { claims } = await api(`/api/chain/claimable?wallet=${S.me.wallet}`);
      const mine = claims.filter((c) => c.mint === mint);
      if (!mine.length) { box.innerHTML = ''; return; }
      const total = mine.reduce((s2, c) => s2 + c.amountUi, 0);
      box.innerHTML = `<div class="claimbox"><div><div class="hint">Unclaimed rewards</div><div class="num gold" style="font-size:18px">${fmtQ(total, t.quote)}</div><div class="hint">${mine.length} epoch${mine.length > 1 ? 's' : ''}</div></div><button class="btn cta sm" id="claimAll"><span>Claim</span></button></div>`;
      $('#claimAll', box).onclick = async () => {
        const btn = $('#claimAll', box); btn.disabled = true;
        for (const c of mine) {
          try {
            const r = await CHAIN.act('claim-reward', { mint, index: c.index, amount: c.amount, proof: c.proof }, { onStage: (st) => { btn.firstChild.textContent = st === 'signing' ? 'Confirm…' : 'Claiming…'; } });
            toast('ok', `Claimed <b>${fmtQ(c.amountUi, t.quote)}</b> · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">tx</a>`, t.image);
          } catch (e) { toast('err', niceErr(e)); break; }
        }
        mountClaims();
      };
    } catch { box.innerHTML = ''; }
  }
  const fmtHours = (hrs) => { const real = hrs / scale; return real < 1 ? `${Math.max(1, Math.round(real * 60))}m` : `${real.toFixed(real < 10 ? 1 : 0)}h`; };
  let holdersCache = null;

  // ---- tabs
  async function mountTab() {
    const el = $('#tabBody', root); if (!el) return;
    if (tab === 'trades') { const { trades } = await api(`/api/tokens/${mint}/trades`); el.innerHTML = tradesTable(trades); }
    if (tab === 'holders') { const { holders } = await api(`/api/tokens/${mint}/holders`); holdersCache = holders; el.innerHTML = holdersTable(holders); }
    if (tab === 'chat') { const { chat } = await api(`/api/tokens/${mint}/chat`); el.innerHTML = `<div class="chat"><div class="msgs" id="msgs">${chat.map(chatRow).join('') || '<div class="dim">No messages yet. Say something.</div>'}</div><form id="chatF"><input id="chatIn" placeholder="${d.chatGate?.ok ? 'Say something…' : h(d.chatGate?.reason || 'Sign in to chat')}" ${d.chatGate?.ok ? '' : 'disabled'} maxlength="280"><button class="btn" ${d.chatGate?.ok ? '' : 'disabled'}>Send</button></form></div>`; const m = $('#msgs', el); m.scrollTop = m.scrollHeight;
      $('#chatF', el).onsubmit = async (e) => { e.preventDefault(); const i = $('#chatIn', el); const v = i.value.trim(); if (!v) return; i.value = ''; try { await api('/api/chat', { mint, text: v }); } catch (err) { toast('err', niceErr(err)); } }; }
    if (tab === 'social') {
      const { top } = await api(`/api/ref/top?mint=${mint}`);
      el.innerHTML = `<div class="two"><div id="postsPanel"></div>
        <div id="calloutPanel"></div></div>
        <div class="two" style="margin-top:14px"><div>
        <h3 style="margin-bottom:8px">${icon('link')}Who is bringing the volume</h3>${top.length
          ? `<table class="tbl"><tr><th>#</th><th>Sharer</th><th class="r">Brought</th><th class="r">Volume</th><th class="r">Earned</th></tr>${top.map((r, i) => `<tr><td class="dim">${i + 1}</td><td>${walletLink(r.wallet, r.who)}</td><td class="r">${r.brought}</td><td class="r">${fmtQ(r.volume, t.quote)}</td><td class="r gold">${r.earned > 0 ? fmtQ(r.earned, t.quote) : '—'}</td></tr>`).join('')}</table>`
          : '<div class="empty">Nobody has brought a buyer yet. Your link is in the panel on the right.</div>'}</div><div></div></div>`;
      mountPosts();
      mountCallouts();
    }
    if (tab === 'payouts') { const { epochs, recent } = await api(`/api/tokens/${mint}/payouts`); el.innerHTML = epochs.length ? `<div class="two"><div><h3 style="margin-bottom:8px">Epochs</h3><table class="tbl"><tr><th>When</th><th class="r">Pool</th><th class="r">Holders paid</th></tr>${epochs.map((e) => `<tr><td>${ago(e.ts)} ago</td><td class="r gold">${fmtQ(e.pool, t.quote)}</td><td class="r">${e.holders}</td></tr>`).join('')}</table></div><div><h3 style="margin-bottom:8px">Recent payouts</h3><table class="tbl"><tr><th>Holder</th><th class="r">Paid</th></tr>${recent.map((p) => `<tr><td>${walletLink(p.wallet, p.who)}</td><td class="r gold">${fmtQ(p.amount, t.quote)}</td></tr>`).join('')}</table></div></div>` : '<div class="empty">No epochs paid yet — the first payout lands when the countdown hits zero.</div>'; }
    if (tab === 'info') el.innerHTML = `<div class="stack"><p style="font-size:14px;line-height:1.6">${h(t.description) || '<span class="dim">No description.</span>'}</p><div class="row wrap">${socialLinks(t)}</div>
      <table class="tbl"><tr><td class="muted">Mint</td><td class="mono">${t.mint} <button class="btn sm" data-copy="${t.mint}">copy</button></td></tr><tr><td class="muted">Creator</td><td>${walletLink(t.creator, d.creatorName)}</td></tr><tr><td class="muted">Quote</td><td>${qchip(t.quote)} <span class="muted">${fmtUsd(usd())} each</span></td></tr><tr><td class="muted">Supply</td><td class="mono">1,000,000,000</td></tr><tr><td class="muted">Fair Open</td><td>${t.fairOpenSecs ? `${t.fairOpenSecs}s window · cleared ${fmtQ(t.fairOpenTotal, t.quote)} from ${t.fairOpenBidders} bidders at ${fmtPrice(t.fairOpenPrice)} ${t.quote}` : 'none (instant open)'}</td></tr><tr><td class="muted">Fee on a swap</td><td>${(t.taxBps / 100).toFixed(1)}% total <span class="muted">— ${(t.fees.holderBps / 100).toFixed(1)}% holders (${(t.fees.holderNetBps / 100).toFixed(2)}% to them, ${((t.fees.holderBps - t.fees.holderNetBps) / 100).toFixed(2)}% REX)${t.fees.creatorBps ? `, ${(t.fees.creatorBps / 100).toFixed(1)}% creator` : ''}${t.fees.vaultBps ? `, ${(t.fees.vaultBps / 100).toFixed(1)}% vault` : ''}${t.fees.burnBps ? `, ${(t.fees.burnBps / 100).toFixed(1)}% burn` : ''}</span></td></tr><tr><td class="muted">On a send</td><td>0% — the fee is quote-side and swap-only, never taken in $${h(t.symbol)}</td></tr>${t.fees.vaultBps ? `<tr><td class="muted">Vault</td><td class="mono">${t.buckets.vaultAddress} <span class="muted">· 70% LP / 30% quote bid · no redeem</span></td></tr>` : ''}<tr><td class="muted">Raise</td><td class="mono">${fmtNum(t.raiseTarget)} ${t.quote} (${fmtUsd(t.raiseTarget * usd())})</td></tr></table></div>`;
    $$('[data-copy]', el).forEach((b) => b.onclick = () => { copyText(b.dataset.copy).then((ok) => toast(ok ? 'ok' : 'err', ok ? 'Copied' : 'Could not copy — select it and copy by hand')); });
  }
  const tradeRow = (x, cls = '') => `<tr class="${cls}"><td class="dim">${ago(x.ts)}</td><td>${walletLink(x.wallet, x.who)}${x.wallet === t.creator ? ' <span class="chip dev" style="height:18px;font-size:10px">dev</span>' : ''}</td><td class="${x.side === 'buy' ? 'up' : 'down'}" style="font-weight:600">${x.side}${x.kind === 'fairopen' ? ` <span class="chip fair" style="height:18px;font-size:10px">${icon('scales')}fair</span>` : x.kind === 'amm' ? ' <span class="chip grad" style="height:18px;font-size:10px">amm</span>' : ''}</td><td class="r">${fmtNum(x.quote)} ${t.quote}</td><td class="r">${fmtNum(x.tokens)}</td><td class="r dim">${fmtPrice(x.price)}</td></tr>`;
  const tradesTable = (rows) => `<table class="tbl" id="tradesT"><tr><th>Time</th><th>Wallet</th><th>Side</th><th class="r">${h(t.quote)}</th><th class="r">$${h(t.symbol)}</th><th class="r">Price</th></tr>${rows.map((x) => tradeRow(x)).join('')}</table>`;
  const holdersTable = (rows) => `<table class="tbl"><tr><th>#</th><th>Holder</th><th class="r">Balance</th><th class="r">% supply</th><th>Held</th><th class="r">Share of next payout</th><th class="r">Earned</th></tr>${rows.map((x, i) => `<tr><td class="dim">${i + 1}</td><td>${walletLink(x.wallet, x.who)}${x.isDev ? ' <span class="chip dev" style="height:18px;font-size:10px">dev</span>' : ''}</td><td class="r">${fmtNum(x.amount)}</td><td class="r">${(x.pct * 100).toFixed(2)}%</td><td class="dim" style="font-size:12px">${x.heldSince ? ago(x.heldSince) : '—'}</td><td class="r">${x.belowFloor ? '<span class="dim" title="under the $20 floor">—</span>' : (x.share * 100).toFixed(2) + '%'}</td><td class="r gold">${x.yieldEarned > 0 ? fmtQ(x.yieldEarned, t.quote) : '—'}</td></tr>`).join('')}</table>`;
  const chatRow = (m) => `<div class="m"><b>${h(m.name)}</b>${h(m.text)}<span class="t">${ago(m.ts)}</span></div>`;

  let lastMcap = t.mcapUsd;
  function updateHead() {
    const usd_ = usd(); const big = $('#pxBig', root); if (!big) return; const mc = t.price * 1e9 * usd_; big.textContent = fmtUsd(mc); if (Math.abs(mc - lastMcap) > 1e-9) flashNum(big, mc >= lastMcap ? 1 : -1); lastMcap = mc;
    $('#pxSub', root).textContent = `${fmtPrice(t.price)} ${t.quote} · ${fmtUsd(t.price * usd_)}`; $('#kMcap', root).textContent = fmtUsd(t.price * 1e9 * usd_); $('#kHold', root).textContent = t.holders; $('#kTrades', root).textContent = t.trades; $('#kPaid', root).textContent = fmtUsd(t.yieldPaid * usd_);
    if (t.status !== 'graduated') { const p = Math.min(1, t.raised / t.raiseTarget); const b = $('#curveBar', root); if (b) b.style.width = (p * 100).toFixed(2) + '%'; const pc = $('#curvePct', root); if (pc) pc.textContent = (p * 100).toFixed(2) + '%'; const cr = $('#curveRaised', root); if (cr) cr.textContent = `${fmtNum(t.raised)} ${t.quote} raised`; }
    // Same sum as the first render; updating only `yieldPool` here would silently drop the accrued
    // side the moment anything refreshed the panel.
    const pool = $('#cvPool', root); if (pool) { const tot = (t.yieldPool || 0) + (t.pendingYield || 0); pool.textContent = fmtQ(tot, t.quote); $('#cvPoolUsd', root).textContent = fmtUsd(tot * usd_); }
  }
  render();
  const offs = [];
  offs.push(bus.on('trade', (m) => { if (m.mint !== mint) return; try { chart?.pulse(m.side); } catch {} t.price = m.candle?.c ?? t.price; t.trades++; if (m.kind === 'curve') { t.raised += m.side === 'buy' ? m.quote - m.fee - m.tax : -(m.quote / (1 - 0.01 - t.taxBps / 1e4)); t.raised = Math.max(0, t.raised); } t.yieldPool += m.tax + (m.kind === 'amm' ? m.fee : 0); liveCandle(m.candle); updateHead();
    if (tab === 'trades') { const tb = $('#tradesT', root); if (tb) { tb.rows[0].insertAdjacentHTML('afterend', tradeRow(m, 'new')); if (tb.rows.length > 60) tb.deleteRow(-1); } }
    if (me && m.wallet !== me.wallet && t.status !== 'fairopen') { /* refresh balances lazily */ } }));
  offs.push(bus.on('fairopen', (m) => { if (m.mint !== mint) return; t.fairOpenTotal = m.total; t.fairOpenBidders = m.bidders; const a = $('#foTotal', root); if (a) { a.textContent = fmtQ(m.total, t.quote); $('#foBidders', root).textContent = m.bidders; $('#foMcap', root).textContent = fmtUsd(estOpenMcap()); } }));
  offs.push(bus.on('settled', async (m) => { if (m.mint !== mint) return; toast('gold', `${icon('scales')}Fair Open cleared: <b>${m.bidders} bidders</b> at one price · ${fmtQ(m.total, t.quote)}`, t.image); d = await api(`/api/tokens/${mint}`); t = d.token; me = d.me; render(); }));
  offs.push(bus.on('graduated', async (m) => { if (m.mint !== mint) return; d = await api(`/api/tokens/${mint}`); t = d.token; me = d.me; render(); }));
  offs.push(bus.on('yield', async (m) => { if (m.mint !== mint) return; mountClaims(); t.yieldPool = 0; t.yieldPaid += m.pool; t.yieldEpochs++; t.yieldPayouts += m.holders; if (me) { try { const r = await api(`/api/tokens/${mint}`); me = r.me; } catch {} } mountConv(); updateHead(); if (tab === 'payouts') mountTab(); }));
  offs.push(bus.on('chat', (m) => { if (m.mint !== mint) return; const box = $('#msgs', root); if (box) { box.insertAdjacentHTML('beforeend', chatRow(m)); box.scrollTop = box.scrollHeight; } }));
  offs.push(bus.on('auth', async () => { d = await api(`/api/tokens/${mint}`); me = d.me; mountTrade(); mountConv(); }));
  offs.push(every(1000, () => { const r = $('#tradePanel .ring', root); if (r) { if (!isFO()) return; tickRing(r, t.fairOpenEnds - Date.now(), t.fairOpenSecs * 1000); } const r2 = $('#convPanel .ring', root); if (r2) tickRing(r2, S.nextEpochAt - Date.now(), S.epochMs); }));
  offs.push(every(15000, async () => { try { const r = await api(`/api/tokens/${mint}`); const was = t.status; t = { ...t, ...r.token }; me = r.me; if (r.token.status !== was) { d = r; render(); return; } $('#kVol', root).textContent = fmtUsd(t.vol24 * usd()); $('#kLiq', root).textContent = fmtUsd(t.liquidity * usd()); const c = $('#pxChg', root); c.textContent = `${pct(t.chg1h)} 1h`; c.className = t.chg1h == null ? 'dim' : t.chg1h >= 0 ? 'up' : 'down'; } catch {} }));
  document.addEventListener('keydown', keys); function keys(e) { if (e.target.matches('input,textarea')) return; if (e.key === 'b' || e.key === 'B') { side = 'buy'; mountTrade(); } if (e.key === 's' || e.key === 'S') { side = 'sell'; mountTrade(); } }
  return () => { offs.forEach((f) => f()); chart?.destroy(); subscribe(null); document.removeEventListener('keydown', keys); document.getElementById('mtrade')?.remove(); };
}

// ============================================================ CREATE
export async function create(root) {
  // Four buckets in half-point steps. The contract rejects a sum over 4% and any field over its
  // ceiling, so the sum is on screen before the launch tx is ever built.
  const f = { name: '', symbol: '', description: '', image: null, website: '', twitter: '', telegram: '',
    // The "Open" preset, as agreed: 1% holders / 0.5% creator / 0.5% vault / 0% burn = 2% total.
    // SOL is the opening pair while liquidity builds; $REX is the next chip along.
    quote: 'SOL', holderBps: 100, creatorBps: 50, vaultBps: 50, burnBps: 0, buybackBps: 0, fairOpenSecs: (S.fairOpenDefault ?? 60), devBuy: '',
    // ⛔ SHARE & EARN IS ON BY DEFAULT, AT HALF THE CREATOR'S OWN CUT. It used to be 0 — off, and
    // three taps deep inside Advanced — while "Every holder is a distributor" is the third thing
    // the home page says about this platform. Elio, 8 Nov: "that's our mode … make the default
    // launch that, and instead of just hiding it on advanced put it on the front, so people see it
    // every time they launch with us." A differentiator nobody is shown is not a differentiator.
    //
    // It costs holders and the 5% ceiling NOTHING: this is a split of the creator's own bucket, so
    // a launcher who wants all of it moves one control. The 50 is deliberate rather than tidy —
    // `refQuick` has offered exactly 5000 as the sensible starting point since the control shipped.
    allowlist: '', allowRexUsd: 0, walletCap: 0, decayFeeBps: 0, decayTo: 'vault', refShareBps: 5000, rewardMode: 'hold', aiMode: 'off', program: null, payoutRule: 'all', payoutN: 25, payoutAssets: null, hook: 'none' };
  // A cluster deployment only offers the quotes that exist on it — devnet has no wrapped SOL stand-in
  // — so a hardcoded default would leave the form pointing at a pair the server would reject.
  if (S.quotes?.length && !S.quotes.some((q) => q.symbol === f.quote)) f.quote = S.quotes[0].symbol;
  window.__rexQuote = f.quote;
  // Ceilings come from the server, which reads them from the same module the contract enforces —
  // a hardcoded cap here is a cap that drifts out of sync with the chain.
  const FM = S.fees || { stepBps: 50, holderMinBps: 100, holderMaxBps: 300, sideMaxBps: 100, capBps: 400 };
  const CAP = FM.capBps;
  const steps = (lo, hi) => { const out = []; for (let v = lo; v <= hi; v += FM.stepBps) out.push(v); return out; };
  const HOLDER_RANGE = steps(FM.holderMinBps, FM.holderMaxBps), SIDE_RANGE = steps(0, FM.sideMaxBps);
  const VAULT_RANGE = steps(0, FM.vaultMaxBps ?? FM.sideMaxBps);   // Value / Vault runs to 2%
  const sum = () => f.holderBps + f.creatorBps + f.vaultBps + f.burnBps + f.buybackBps;
  // The shipped default has a name so people can talk about it. It stops being "Open" the moment
  // anyone moves a slider, which is the point of naming it rather than labelling the whole screen.
  const isOpenPreset = () => f.holderBps === 100 && f.creatorBps === 50 && f.vaultBps === 50 && f.burnBps === 0 && f.buybackBps === 0;
  const legal = () => sum() <= CAP;
  // REX's protocol fee is an absolute share of the trade carved OUT of the holder allocation, so it
  // can never be more than the allocation itself.
  const rexCut = () => Math.min(f.holderBps, FM.rexTiers?.[0]?.bps ?? 50);
  // Programs are presets, not modes: each one writes the ordinary fields below and nothing else, so
  // a launcher can take one and then change any part of it. Nothing here does something the form
  // cannot express — a preset that hid behaviour would be a preset nobody could audit.
  // ⛔ THE ASSET LIST COMES FROM THE SERVER, NOT FROM HERE. The copy this replaces named "SOL,
  // USDC, REX, WIF, BONK or JUP" — and BONK and JUP are not in the quotes registry at all, so they
  // have no mint, no decimals and no price and could never have been paid. A list typed into the
  // client is a list that drifts from the one table that can actually pay it.
  // Every asset this platform can actually pay a holder in — derived on the SERVER from the quotes
  // registry (see ai_alloc.dividendAssets), which is the only place a mint, its decimals and a live
  // price are known together. The AI dividend picks from this list; so does the picker below. It is
  // one list with one source on purpose: a second one typed into the client is a list that drifts
  // from the table that pays, and then a coin promises an asset the epoch will refuse.
  const payableAssets = () => S.ai?.assets || [];
  const aiAvailable = () => !!S.ai?.dividend && payableAssets().length > 0;
  // ⛔ EXACTLY 10_000 BPS OR `normalizeBasket` REFUSES THE LAUNCH. Splitting evenly leaves a
  // remainder on anything that does not divide 10,000 — three legs give 3,333 each and lose a basis
  // point — so the first leg carries it. Never let this return a basket that does not total 10,000.
  const PAYOUT_MAX_LEGS = 5;
  const splitEven = (syms) => {
    if (!syms.length) return null;
    const base = Math.floor(10_000 / syms.length);
    return syms.map((asset, i) => ({ asset, bps: base + (i === 0 ? 10_000 - base * syms.length : 0) }));
  };
  const aiAssetList = () => {
    const a = payableAssets().map((x) => `$${x}`);
    return a.length > 1 ? `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}` : (a[0] || 'no asset');
  };
  const PROGRAMS = [
    // ⛔ THERE WERE THREE CARDS HERE. 'Fund manager' promised a model re-splitting each hour's fees
    // between burn, holders and treasury; 'Dip buyer' promised accumulated fees spent on
    // buyback-and-burn on the model's timing. Both were removed on 23 Oct, and the reason is worth
    // keeping: on a live launch nothing SPENDS burn_pot, buyback_pot or vault_pot — engine.runEpoch
    // settles those for the paper curve only (`paper = t.venue !== 'dbc'`) and payout.mjs counts
    // them as liabilities and sends none. Wiring those cards would have had a model moving holders'
    // money into pots nothing drains. The card promised a burn; the code would have given an
    // accounting entry. See lib/ai_alloc.mjs MODES before adding either one back.
    //
    // 'Dividend picker' stayed because its rail is real: the asset goes into `payoutAssets`, which
    // the epoch already spends — the same column the three "Pay holders" basket cards below use.
    // Only offered when the server says a model is configured; see `aiAvailable`.
    { key: 'ai-dividend', cat: 'AI', label: 'Dividend picker', note: 'Chooses the payout asset hourly',
      detail: `Holders are paid in one asset that a model picks each hour from ${aiAssetList()} — and from nothing else. Your split and your proportions are untouched; only what it is paid in changes. Every pick, and the numbers behind it, is recorded and served at <code>/api/ai/&lt;mint&gt;</code>. If the model is unreachable the coin keeps paying the asset it last picked.`,
      set: { payoutAssets: null, aiMode: 'dividend', holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'holders-max', cat: 'Pay holders', label: 'Everything to holders', note: '3% — the maximum',
      detail: 'The whole holder bucket at its ceiling and nothing else on. The simplest promise a coin can make.',
      set: { payoutAssets: null, aiMode: 'off', holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'holders-diamond', cat: 'Pay holders', label: 'Diamond hands', note: 'Long holders earn 3x',
      detail: 'Holder rewards weighted by how long each wallet has held, up to 3x at three days. Selling resets the clock.',
      set: { payoutAssets: null, aiMode: 'off', rewardMode: 'hold', holderBps: 250, creatorBps: 50, burnBps: 0, buybackBps: 0, vaultBps: 0 } },
    { key: 'whale-club', cat: 'Pay holders', label: 'Whale Club', note: 'Only the top 25 get paid',
      detail: 'The whole holder bucket is split between the 25 largest wallets. Everyone below gets nothing — a blunt instrument, and the point is that it is blunt.',
      set: { payoutAssets: null, aiMode: 'off', payoutRule: 'whale', payoutN: 25, holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'shrimp-fund', cat: 'Pay holders', label: 'Shrimp Fund', note: 'Whales excluded',
      detail: 'The 25 largest wallets are excluded and everyone else splits the bucket. Pays the people a pro-rata split pays least.',
      set: { payoutAssets: null, aiMode: 'off', payoutRule: 'shrimp', payoutN: 25, holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'flat-dividend', cat: 'Pay holders', label: 'Flat Dividend', note: 'Same amount to everyone',
      detail: 'Every wallet above the $20 floor receives the identical amount, whatever it holds and however long. One wallet, one share.',
      set: { payoutAssets: null, aiMode: 'off', payoutRule: 'equal', rewardMode: 'flat', holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    // ⛔ THESE THREE SET `payoutAssets`, which is the column the epoch actually spends. They used
    // to set `payoutAsset` — written here, stored, whitelisted, and read by nothing that pays — so
    // every coin launched on "Earn WIF" paid its quote while this card promised WIF. That field is
    // now gone from the form, the schema and publicToken; do not reintroduce it. The old BONK card
    // could never have worked even in principle: BONK is not in the quotes registry, so there is
    // no mint, no decimals and no price to pay it with.
    { key: 'earn-wif', cat: 'Pay holders', label: 'Earn WIF', note: 'Holders paid in $WIF',
      detail: 'The holder bucket is paid out entirely in $WIF rather than the quote asset. A basket of one.',
      set: { aiMode: 'off', payoutAssets: [{ asset: 'WIF', bps: 10_000 }], holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'earn-doge', cat: 'Pay holders', label: 'Earn DOGE', note: 'Holders paid in $DOGE',
      detail: 'The holder bucket is paid out entirely in $DOGE rather than the quote asset.',
      set: { aiMode: 'off', payoutAssets: [{ asset: 'DOGE', bps: 10_000 }], holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'pay-a-basket', cat: 'Pay holders', label: 'Pay a basket', note: 'Holders paid in three assets at once',
      detail: 'Every payout is split across $DOGE, $WIF and SOL — 40/40/20. Holders are paid in all three on the same epoch, each converted at its own price.',
      set: { aiMode: 'off', payoutAssets: [{ asset: 'DOGE', bps: 4000 }, { asset: 'WIF', bps: 4000 }, { asset: 'SOL', bps: 2000 }], holderBps: 300, burnBps: 0, buybackBps: 0, vaultBps: 0, creatorBps: 0 } },
    { key: 'burn-max', cat: 'Burn', label: 'Burn it all', note: 'Every fee destroys supply',
      detail: 'The entire fee buys your token on the open market and destroys it. No payout, no treasury — supply only goes down.',
      set: { payoutAssets: null, aiMode: 'off', burnBps: 100, buybackBps: 100, holderBps: 100, vaultBps: 0, creatorBps: 0 } },
    { key: 'burn-half', cat: 'Burn', label: 'Half burn, half holders', note: 'Supply down, holders paid',
      detail: 'Half the fee is destroyed, half pays holders. The usual compromise, and a defensible one.',
      set: { payoutAssets: null, aiMode: 'off', burnBps: 100, holderBps: 150, buybackBps: 0, vaultBps: 0, creatorBps: 50 } },
    { key: 'route-vault', cat: 'Route', label: 'Build the vault', note: 'Fees become liquidity',
      detail: 'Fees are deployed as liquidity rather than paid out, so the book gets deeper every trade. Locked — there is no redeem.',
      set: { payoutAssets: null, aiMode: 'off', vaultBps: 150, holderBps: 100, burnBps: 50, buybackBps: 0, creatorBps: 0 } },
    { key: 'route-creator', cat: 'Route', label: 'Fund the build', note: 'Creator-weighted',
      detail: 'A larger creator cut for a team that is actually shipping, with holders still paid on every swap.',
      set: { payoutAssets: null, aiMode: 'off', creatorBps: 100, holderBps: 150, vaultBps: 50, burnBps: 0, buybackBps: 0 } },
  ];
  // ⛔ A CARD FOR SOMETHING THIS BOX CANNOT DO IS NOT SHOWN AT ALL. With no model configured the
  // dividend mode has nothing to pick with, so the card goes — rather than being offered, chosen,
  // stored, and silently leaving the coin paying its quote. This is the whole class of bug the AI
  // row used to be: a promise in the UI with nothing behind it.
  const PROGRAMS_ON = PROGRAMS.filter((x) => x.cat !== 'AI' || aiAvailable());
  const PROGRAM_CATS = [...new Set(PROGRAMS_ON.map((x) => x.cat))];
  // Arriving from a card on the home page: open on the category that was tapped. Without this the
  // card would navigate here and still show something else, which is its own kind of "nothing
  // happened". 'Recipes' has no presets of its own yet, so it lands on AI — the nearest thing that
  // does something — rather than on an empty row.
  // ⛔ AND THE DEFAULT FALLS BACK TO WHAT EXISTS. This used to default to 'AI' outright, which was
  // safe only while the AI row always had cards in it. With the row now dropped on a deployment
  // that has no model, a hardcoded 'AI' would open the screen on an empty tab.
  const wanted = new URLSearchParams(location.search).get('program');
  let pgCat = PROGRAM_CATS.includes(wanted) ? wanted
    : PROGRAMS_ON.find((x) => x.key === f.program)?.cat
      || (PROGRAM_CATS.includes('AI') ? 'AI' : PROGRAM_CATS[0]);
  // Deep-linked into Advanced, because that is where the programs live.
  let tab = wanted ? 'adv' : 'quote';

  const TABS = [
    { key: 'quote', label: 'Quote',    cats: ['native', 'stable', 'custom'], note: 'SOL leads while liquidity builds. $REX is the one-tap upgrade — your holders get paid in $REX. $CARDS joins them with $3.5M of liquidity and no mint or freeze authority at all.' },
    { key: 'meta',  label: 'META',     cats: ['meta'],  note: 'Top Stonk coins, as pairs. This is the book that is already trading.' },
    { key: 'alt',   label: 'ALTS',     cats: ['alt'],   note: 'The majors, bridged onto Solana. Every one is on Jupiter\'s verified list — a ticker search returns mostly clones.' },
    { key: 'lev',   label: 'Leverage', cats: ['leverage'], note: 'Leveraged exposure as a pair — Hylo\'s xSOL, xBTC and xHYPE, plus Jupiter\'s perps LP. Each one is thinner than SOL or USDC, so a big launch moves the pair itself; the warning on each says which. $JLP\'s issuer can also freeze accounts, which the Hylo ones cannot.' },
    { key: 'stock', label: 'Stocks',   cats: ['stock'], note: 'Real equities, from the two issuers that tokenise them on Solana — xStocks and Backpack Securities. Which one holds the book depends on the company, so each entry is whichever actually trades, with its measured impact. ⚠️ Every one of them can be frozen, paused, or moved out of your wallet by its issuer — that is what a regulated security on chain is. $CARDS and SOL cannot.' },
    { key: 'rules', label: 'Rules',    cats: null,    note: 'Rules that live in the token itself, enforced on every transfer by a Token-2022 hook. Optional, and permanent.' },
    { key: 'adv',   label: 'Advanced', cats: null,      note: 'How holder rewards are split, auto-allocation presets, plus creator, vault, burn, allowlist, wallet cap and decay fee. Everything except the reward split is off by default.' },
  ];
  // $REX leads: it is the default pair, and launching against it is what the gate rewards.
  // Order comes from the server, which declares it once in lib/prices.mjs. This used to force REX to
  // the front — correct while REX was the default, wrong now that SOL leads, and the kind of second
  // opinion about ordering that silently overrides the first one.
  /**
   * Can this pair launch on the second venue?
   *
   * ⛔ Meteora refuses a quote mint that charges a transfer fee — $GP, $ZCAT, $MASK, $SI, $ALLINU.
   * Raydium's LaunchLab takes them. So a pair blocked on Meteora is not unavailable; it launches
   * somewhere else, and greying it out tells the launcher the opposite of the truth.
   */
  /**
   * What the creator takes out of every trade, in bps, on the venue this launch will use.
   *
   * ⛔ THE TWO VENUES KEEP THIS IN DIFFERENT FIELDS. The paper curve has `creatorBps`, already bps
   * of a trade. Meteora and LaunchLab charge `poolFeeBps` and give the creator a PERCENTAGE of it.
   * Share & earn gated itself on `creatorBps` regardless, so on the live venue a launcher with a
   * perfectly good 1% creator cut was told to "set a creator cut above first" — the control for
   * the feature Elio calls our moat, hidden behind a gate that could not open.
   */
  const creatorCutBps = () => (S.venue === 'dbc' || venueFor(f.quote) === 'launchlab'
    ? Math.round((f.poolFeeBps ?? 200) * (f.creatorSharePct ?? 50) / 100)
    : (f.creatorBps || 0));
  const onLaunchLab = (sym) => !!S.launchlab?.enabled && (S.launchlab.pairs || []).includes(sym);
  /** Which venue a launch of this pair goes to. */
  const venueFor = (sym) => {
    const q = S.quotes.find((x) => x.symbol === sym);
    if (q?.unavailable && onLaunchLab(sym)) return 'launchlab';
    return S.venue === 'dbc' ? 'dbc' : 'rexpad';
  };
  const quotesIn = (cats) => S.quotes.filter((q) => cats.includes(q.category))
    .sort((a, b) => cats.indexOf(a.category) - cats.indexOf(b.category));
  /** The live sum, on the front screen and on Advanced — identical markup, rendered twice. */
  const sumBar = () => {
    const over = !legal();
    const seg = (bps, cls, label) => bps > 0 ? `<i class="fsg ${cls}" style="flex:${bps}" title="${label} ${(bps / 100).toFixed(1)}%"></i>` : '';
    return `<div class="feesum ${over ? 'over' : ''}">
      <div class="row between"><div class="l">Total fee on every swap${isOpenPreset() ? ' <span class="chip sm">Open</span>' : ''}</div><div class="v">${(sum() / 100).toFixed(1)}%<span class="dim"> / ${(CAP / 100).toFixed(0)}% cap</span></div></div>
      <div class="fsbar">${seg(f.holderBps, 'h', 'Holders')}${seg(f.creatorBps, 'c', 'Creator')}${seg(f.vaultBps, 'v', 'Vault')}${seg(f.burnBps, 'b', 'Burn')}${seg(f.buybackBps, 'k', 'Buyback')}<i class="fsg rest" style="flex:${Math.max(0, CAP - sum())}"></i></div>
      <div class="fslegend">
        <span><i class="fsg h"></i>Holders ${(f.holderBps / 100).toFixed(1)}%<small>${((f.holderBps - rexCut()) / 100).toFixed(2)}% to them, ${(rexCut() / 100).toFixed(2)}% REX fee</small></span>
        ${f.creatorBps ? `<span><i class="fsg c"></i>You ${(f.creatorBps / 100).toFixed(1)}%<small>quote, each epoch</small></span>` : ''}
        ${f.vaultBps ? `<span><i class="fsg v"></i>Vault ${(f.vaultBps / 100).toFixed(1)}%<small>70% LP / 30% bid</small></span>` : ''}
        ${f.burnBps ? `<span><i class="fsg b"></i>Burn ${(f.burnBps / 100).toFixed(1)}%<small>buys &amp; burns</small></span>` : ''}
        ${f.buybackBps ? `<span><i class="fsg k"></i>Buyback ${(f.buybackBps / 100).toFixed(1)}%<small>buys &amp; keeps</small></span>` : ''}
      </div>
      ${over ? `<div class="fserr">${(sum() / 100).toFixed(1)}% is over the ${(CAP / 100).toFixed(0)}% cap — the contract would reject this launch.</div>`
             : '<div class="hint">Quote asset, swaps only. A send pays nothing, and the fee is never taken in your token.</div>'}
    </div>`;
  };
  const stepRow = (id, bps, range, max) => `<div class="opts tight" id="${id}">${range.map((v) => {
    const blocked = v > max;
    // A 0 reads better as "Off" than as "0%" — Elio asked for the burn and vault to be switchable,
    // and a row that opens with Off says so without needing a second control.
    // ⛔ BOTH Share & earn ROWS, not the Advanced one by name. This read `id === 'advRefShare'`
    // while that was the only copy; the front copy would have fallen into the fee branch, which
    // rounds to a half point. The five steps happen to render the same either way, so nothing
    // would have looked wrong — until someone added a step that does not land on one, and then the
    // two screens would quote the same launcher two different numbers. Matching the row, not its
    // location, is the difference between agreeing and happening to agree.
    const label = v === 0 ? 'Off' : (/RefShare$/.test(id) ? `${v / 100}%` : `${(v / 100).toFixed(v % 100 ? 1 : 0)}%`);
    return `<button data-v="${v}" class="${v === bps ? 'on' : ''}${blocked ? ' blocked' : ''}">${label}</button>`;
  }).join('')}</div>`;
  /**
   * The Rules tab.
   *
   * ⛔ THIS IS THE MOST CONSEQUENTIAL CHOICE ON THE WHOLE FORM AND IT HAS TO READ THAT WAY. A
   * transfer hook is a third-party program with a veto over every transfer of the coin — every buy,
   * every sell, every send — and the mint is immutable, so it can never be removed, edited or
   * turned off. Picking one also changes what the coin IS: only a Token-2022 mint can carry a hook,
   * so the launch stops being a plain SPL token and some wallets and aggregators will treat it
   * differently. None of that is a footnote, so none of it is in a tooltip.
   *
   * Rules whose program we could not verify on chain are shown and disabled rather than hidden: a
   * menu that silently drops an item people have read about reads as a broken page.
   */
  // Fetched once, the first time anyone opens the tab, rather than loaded into /api/state for every
  // visitor on every page. Most launches will never open this tab at all.
  let hooksAsked = false;
  const loadHooks = () => {
    if (hooksAsked) return;
    hooksAsked = true;
    api('/api/hooks')
      .then((d) => { S.hookRules = d.rules || []; if (tab === 'rules') bindTab(); })
      .catch(() => { S.hookRules = []; if (tab === 'rules') bindTab(); });
  };
  const rulesBody = (t) => {
    loadHooks();
    if (!S.hookRules) return `<div class="hint" style="margin-bottom:8px">${t.note}</div><div class="skeleton"></div>`;
    const rules = S.hookRules;
    const chosen = rules.find((r) => r.key === f.hook);
    // Defaults the moment a rule is picked, so the summary below is never describing nothing.
    if (chosen && !f.hookParams) f.hookParams = Object.fromEntries(chosen.params.map((x) => [x.key, x.default]));
    const P = f.hookParams || {};
    const shown = (x) => !x.showIf || String(P[x.showIf.key] ?? '') === String(x.showIf.value);
    const families = [...new Set(rules.map((r) => r.family))];

    /** One setting. The rule decides the kind; this only decides how it is asked for. */
    const field = (x) => {
      const v = P[x.key] ?? x.default;
      const head = `<div class="rp-flab"><span>${h(x.label)}</span>${x.unit ? `<b class="rp-fval" data-for="${h(x.key)}">${h(String(v))} ${h(x.unit)}</b>` : ''}</div>
        ${x.help ? `<div class="rp-fhelp">${h(x.help)}</div>` : ''}`;
      if (x.type === 'choice') {
        return `<div class="rp-field">${head}<div class="opts rp-opts" data-param="${h(x.key)}">${x.options.map((o) =>
          `<button type="button" data-v="${h(o.value)}" class="${String(v) === String(o.value) ? 'on' : ''}">${h(o.label)}</button>`).join('')}</div></div>`;
      }
      if (x.type === 'text' || x.type === 'address' || x.type === 'list') {
        return `<div class="rp-field">${head}<div class="in"><input data-param="${h(x.key)}" value="${h(String(v ?? ''))}" placeholder="${h(x.placeholder || '')}" spellcheck="false"></div></div>`;
      }
      // pct and range are both a slider with a typed box beside it.
      return `<div class="rp-field">${head}<div class="rp-slider">
        <input type="range" data-param="${h(x.key)}" min="${x.min}" max="${x.max}" step="${x.step}" value="${h(String(v))}">
        <input class="rp-num" type="number" data-param="${h(x.key)}" min="${x.min}" max="${x.max}" step="${x.step}" value="${h(String(v))}">
      </div></div>`;
    };

    return `<div class="hint" style="margin-bottom:8px">${t.note}</div>
      <div class="warn" style="margin-bottom:10px">${icon('flame')}<div><b>A rule is permanent.</b>
        It is a separate program that can refuse any transfer of your coin, it applies for as long as the coin exists, and it cannot be removed or changed afterwards.
        Choosing one also makes your coin a Token-2022 mint rather than a plain one, which some wallets and aggregators handle differently.</div></div>
      <div class="rulepick" id="hookPick" role="radiogroup" aria-label="Transfer rules">
        <button data-v="none" class="${f.hook === 'none' || !f.hook ? 'on' : ''}" role="radio" aria-checked="${f.hook === 'none' || !f.hook}">
          <i class="rp-dot" aria-hidden="true"></i>
          <span class="rp-body"><b>No rule</b><small>A plain token. Nothing is added and nothing can refuse a transfer.</small></span>
        </button>
        ${families.map((fam) => `<div class="rp-fam">${h(fam)}</div>${rules.filter((r) => r.family === fam).map((r) => `
          <button data-v="${h(r.key)}" class="${r.key === f.hook ? 'on' : ''}${r.unavailable ? ' blocked' : ''}" role="radio" aria-checked="${r.key === f.hook}"${
            r.unavailable ? ` aria-disabled="true" title="${h(r.label)} cannot be used: ${h(r.unavailable)}"` : ''}>
            <i class="rp-dot" aria-hidden="true"></i>
            <span class="rp-body">
              <b>${h(r.label)}${r.sol > 0 ? `<em class="rp-tag">costs ${r.sol} SOL</em>` : ''}${r.exempt ? '<em class="rp-tag">you are exempt</em>' : ''}</b>
              <small>${r.unavailable ? h(r.unavailable) : h(r.blurb)}</small>
            </span>
          </button>`).join('')}`).join('')}
      </div>
      ${chosen ? `<div class="rp-detail" id="rpDetail">
        ${chosen.params.length ? `<div class="rp-fields">${chosen.params.filter(shown).map(field).join('')}</div>` : ''}
        ${chosen.warn ? `<p class="rp-fund"><b>Worth knowing.</b> ${h(chosen.warn)}</p>` : ''}
        <p class="rp-sum" id="rpSummary">…</p>
        <p class="rp-prog">Enforced by <span class="mono">${h(chosen.program)}</span>, switched on by a second signature right after the pool is created.</p>
      </div>` : ''}`;
  };

  /**
   * ⛔ WHAT A PAIR COSTS YOU OUTSIDE THIS SITE, SAID BEFORE THE LAUNCH AND NOT AFTER IT.
   *
   * ESE launched a coin against WIF and then could not buy it on fomo; Elio forwarded it as "this
   * main issue — we want launches to be bought on fomo no problem". Nothing was broken. An external
   * terminal routes through an aggregator, an aggregator paths from SOL, and there is no liquid
   * path from SOL into a brand-new curve quoted in WIF — so the coin is reachable here and nowhere
   * else until it graduates. That is a real and reasonable trade (an exotic pair is the whole point
   * of this launchpad), but it is a choice, and a choice nobody was told they were making is just a
   * surprise. Two assets every aggregator already routes carry no such cost, and they are named.
   */
  const ROUTABLE = ['SOL', 'USDC'];
  const reachNote = (sym) => {
    if (!sym || ROUTABLE.includes(sym)) return '';
    return `<div class="reach">${icon('globe')}<div><b>A $${h(sym)} pair trades here first.</b> Outside terminals — fomo, Photon, the rest — route buys from SOL, and there is no deep path from SOL into a new ${h(sym)} curve, so they will show your coin but not fill on it until it graduates. Launch against <b>SOL</b> or <b>USDC</b> if being buyable everywhere on day one matters more than the pair.</div></div>`;
  };
  /**
   * Share & earn — rendered on the FRONT screen and again on Advanced, from ONE definition.
   *
   * ⛔ ONE FUNCTION, TWO MOUNT POINTS — the arrangement `sumBar` already uses, and for the same
   * reason: two copies of this markup drift, and the copy people actually read would be whichever
   * drifted. What must stay identical between them is not the shape but the NUMBERS, because both
   * screens are quoting the launcher a percentage of their own money.
   *
   * ⛔ THE ID IS A PARAMETER BECAUSE AN ID CANNOT REPEAT. `stepRow` keys its buttons off it and
   * `pick` re-queries by it, so two rows sharing one id would leave the second row's clicks
   * painting the first row's buttons — the click would take effect and the wrong control would
   * light up. Same reason the quick-fix button below is found by attribute, not by id.
   */
  const SHARE_STEPS = [0, 2500, 5000, 7500, 10000];
  const shareField = (id) => creatorCutBps() === 0
    ? `<div class="needroom">Set a creator cut on Advanced first — share &amp; earn is paid out of it, so with 0% there is nothing to share. <button class="btn sm" data-refquick>Give me 1% to share from</button></div>`
    : `${stepRow(id, f.refShareBps, SHARE_STEPS, 10000)}
       <div class="hint">${f.refShareBps
         ? `Sharers split <b>${((creatorCutBps() * f.refShareBps / 10_000) / 100).toFixed(3)}% of every trade</b> they bring. You keep <b>${((creatorCutBps() * (10_000 - f.refShareBps) / 10_000) / 100).toFixed(3)}%</b>. It costs holders and the ceiling nothing.`
         : 'Off — you keep your whole cut. Every holder still gets a link; turn this on and they have a reason to use it.'}</div>
       ${f.refShareBps
         // ⛔ THIS USED TO SAY "Paying them is not automatic yet … still a manual step", and that
         // has been false since lib/sharers.mjs shipped. The sharers' transfers are built INTO the
         // creator's own claim transaction (server.mjs build/dbc-claim-creator) and settle
         // atomically with it; on the paper curve engine.settleCreator credits them each epoch.
         // Defaulting the feature ON while the form still called it manual would have told every
         // launcher their 50% was a promise nobody keeps.
         ? '<div class="hint">What each sharer brings is tracked from their first trade and shown on the coin\'s page. They are paid <b>inside your own claim transaction</b> — you receive your fee and they receive their slice together, or neither happens. Nothing of yours is ever routed through us.</div>'
         : ''}`;
  const tabBody = () => {
    const t = TABS.find((x) => x.key === tab);
    if (tab === 'rules') return rulesBody(t);
    if (tab !== 'adv') {
      const pool = quotesIn(t.cats);
      // ⛔ TWO REASONS A PAIR CAN BE SHUT, AND THEY READ NOTHING ALIKE. A cluster with no stand-in
      // mint is "mainnet only"; a mint Meteora has not badged is open everywhere except here, and
      // calling that "mainnet only" is simply false. The whole-tab sentence only applies when every
      // pair in the tab is shut for the SAME cluster reason.
      const none = pool.length > 0 && pool.every((q) => q.block?.kind === 'cluster');
      return `<div class="hint" style="margin-bottom:8px">${none
        ? `These are mainnet pairs. The mints do not exist on ${h(pool[0].unavailable)}, so nothing here can be launched against yet — they come back the moment we point at mainnet.`
        : t.note}</div>
      <div class="opts" id="quotes">${quotesIn(t.cats).map((q) => `<button data-q="${q.symbol}" class="${q.symbol === f.quote ? 'on' : ''}${q.unavailable && !onLaunchLab(q.symbol) ? ' blocked' : ''}"${q.unavailable && !onLaunchLab(q.symbol) ? ` title="${h(q.block?.kind === 'badge' ? `${q.name} cannot be a pair here: ${q.block.why}.` : `${q.name} exists on mainnet only — not on ${q.unavailable}`)}"` : onLaunchLab(q.symbol) && q.unavailable ? ` title="Meteora will not take ${h(q.name)} as a pair, so this one launches on Raydium LaunchLab instead."` : ''}><span style="display:flex;align-items:center;gap:6px"><i class="qd" style="width:8px;height:8px;border-radius:50%;background:${q.color};display:inline-block"></i>${q.symbol}</span><small>${onLaunchLab(q.symbol) && q.unavailable ? 'via LaunchLab' : q.block?.kind === 'badge' ? 'no Meteora badge' : q.unavailable ? 'mainnet only' : q.symbol === 'REX' ? 'better launch rate' : q.name}</small>${q.note ? `<em class="qnote">${h(q.note)}</em>` : ''}</button>`).join('')}</div>
      ${reachNote(f.quote)}`;
    }
    return `<div class="hint" style="margin-bottom:8px">${t.note}</div>
      <div class="field"><label>${icon('gem')}Holder rewards <span class="dim">how your holder cut is split between holders — this is set at launch and cannot be changed later</span></label>
        <div class="opts" id="advMode">${[
          ['hold', 'Diamond Hands', 'Longer held = bigger share, up to 3x'],
          ['flat', 'Simple', 'Split by balance alone'],
        ].map(([v, l, d]) => `<button data-v="${v}" class="${v === f.rewardMode ? 'on' : ''}"><span>${l}</span><small>${d}</small></button>`).join('')}</div>
        <div class="hint">${f.rewardMode === 'hold'
          ? 'Weight is your balance times a conviction multiplier that climbs <b>1.0x → 3.0x</b> over three days of holding. A three-day holder earns <b>3x</b> what a same-sized wallet that bought a minute ago earns, and <b>any sell resets that clock to zero</b>. The King List becomes a payslip rather than a trophy.'
          : 'Everyone is paid strictly in proportion to how much they hold. Simple and predictable — but a whale who bought a minute ago out-earns someone who has held a month with half the size.'}</div></div>
      <div class="field"><label>${icon('bolt')}Pick a program <span class="dim">what your fees DO — every one of these just sets the fields below, so you can take any of them and then change your mind</span></label>
        <div class="tabs" id="advPgCat">${PROGRAM_CATS.map((c) => `<button data-v="${c}" class="${c === pgCat ? 'on' : ''}">${c}</button>`).join('')}</div>
        <div class="opts" id="advPg" style="margin-top:8px">${PROGRAMS_ON.filter((x) => x.cat === pgCat).map((x) =>
          `<button data-v="${x.key}" class="${x.key === f.program ? 'on' : ''}"><span>${x.label}</span><small>${x.note}</small></button>`).join('')}</div>
        <div class="hint">${(PROGRAMS_ON.find((x) => x.key === f.program) || {}).detail
          || 'Pick one, or leave it and set the fields yourself.'}</div>
        ${f.aiMode === 'dividend' ? `<div class="note">The model chooses <b>one asset off a fixed list</b> — ${aiAssetList()} — and nothing else. It cannot change your split, your proportions, your caps or your buckets, and it cannot name a wallet or an asset outside that list: it picks, and the ordinary payout pays. A missing, late or nonsense answer changes nothing at all, so your coin keeps paying whatever it last picked. Every pick is recorded with the numbers it saw.</div>` : ''}</div>
      ${(() => {
        // ⛔ WHY THIS CONTROL EXISTS. Julz, 24 Oct: "the basket option worked however $REX is not an
        // option, can you add it." It was never a missing asset — REX has been in the payable
        // allowlist all along and `payoutBasket` would have accepted it. What was missing was any
        // way to SAY so: the basket could only be set by three presets that hardcode WIF, DOGE and
        // SOL, so eleven of the fourteen payable assets were unreachable from the form. Deriving the
        // buttons from the allowlist adds REX and the other ten at once, and cannot drift from it.
        const payable = payableAssets();
        if (!payable.length) return '';
        const legs = Array.isArray(f.payoutAssets) ? f.payoutAssets : [];
        const chosen = legs.map((l) => l.asset);
        return `<div class="field"><label>${icon('gem')}Pay holders in
          <span class="dim">leave these off and holders are paid in the coin's own quote asset · up to ${PAYOUT_MAX_LEGS} assets, split evenly</span></label>
          <div class="opts" id="advPayAssets" style="margin-top:8px">${payable.map((sym) =>
            `<button data-v="${h(sym)}" class="${chosen.includes(sym) ? 'on' : ''}"><span>$${h(sym)}</span></button>`).join('')}</div>
          <div class="hint">${legs.length
            ? `The holder bucket is converted and paid out as ${legs.map((l) => `<b>$${h(l.asset)}</b>&nbsp;${(l.bps / 100).toFixed(l.bps % 100 ? 2 : 0)}%`).join(' · ')}.`
            : 'Holders are paid in whatever your coin is paired against. Pick one or more assets here to pay them in those instead — a basket.'}</div>
          ${(() => {
            // ⛔ WHAT A FEE-BEARING ASSET COSTS, SAID WHERE IT IS CHOSEN. Token-2022 withholds its
            // fee inside the transfer, so paying 100 delivers 97. The rail works every leg back
            // from its arrival and the pot covers the difference — the holder is never short — but
            // the pot buys that much less reward, which is the creator's to weigh and nobody
            // else's. Rates come down with the quote: they are not all the same and a number
            // typed in here would be wrong for half of them the day it was written.
            const taxed = legs.map((l) => (S.quotes || []).find((q) => q.symbol === l.asset))
              .filter((q) => q && q.transferFeeBps > 0);
            if (!taxed.length) return '';
            return `<div class="hint">${taxed.map((q) => `<b>$${h(q.symbol)}</b> charges ${q.transferFeeBps / 100}% on every transfer`).join(' · ')}.
              Your holders still receive exactly the amount their payout says — the pot sends enough extra to cover it — so the cost lands on the holder bucket, not on them.</div>`;
          })()}
          <div class="hint dim">A tokenised stock or a leveraged wrapper cannot be on this list at all: its issuer can freeze the account you paid into, or move the tokens back out of it, after the payout has landed. You can still pair against those — they just cannot be what a holder is paid in.</div></div>`;
      })()}
      <div class="field"><label>Creator <span class="dim">your cut, in the quote asset, paid each epoch · max 1% · REX never touches it</span></label>${stepRow('advCreator', f.creatorBps, SIDE_RANGE, 100)}</div>
      <div class="field"><label>${icon('link')}Share &amp; earn <span class="dim">how much of YOUR OWN cut goes to whoever brings the volume</span></label>
        <div id="advShare">${shareField('advRefShare')}</div></div>
      <div class="field"><label>Value / Vault <span class="dim">arrives as quote and is deposited as liquidity — 70% concentrated LP, 30% quote bid · max 2% · no redeem</span></label>${stepRow('advVault', f.vaultBps, VAULT_RANGE, FM.vaultMaxBps ?? 200)}</div>
      <div class="field"><label>Burn <span class="dim">quote buys your token on the open market and destroys it · max 1%</span></label>${stepRow('advBurn', f.burnBps, SIDE_RANGE, 100)}</div>
      <div class="field"><label>Buyback <span class="dim">quote buys your token on the open market and the treasury keeps it · max 1%</span></label>${stepRow('advBuyback', f.buybackBps, SIDE_RANGE, 100)}
        <div class="hint">${f.buybackBps && f.burnBps
          ? `Buy some, burn some — ${(f.buybackBps / 100).toFixed(1)}% held and ${(f.burnBps / 100).toFixed(1)}% destroyed, every swap, out of the fee rather than out of your own cut.`
          : f.buybackBps ? 'Bought back and held by the treasury. Turn Burn on as well to destroy a slice at the same time.'
          : 'Off. This is the bucket that buys your token and keeps it — without it a team can only buy back by spending its creator cut by hand.'}</div></div>
      <div class="field"><label>Allowlist <span class="dim">inside the open window only — after the clear the pool is public</span></label>
        <textarea id="advAllow" rows="2" placeholder="Paste wallet addresses, one per line (optional)" ${f.fairOpenSecs ? '' : 'disabled'}>${f.allowlist}</textarea>
        <div class="hint">${f.fairOpenSecs ? 'Or gate by $REX held:' : 'An allowlist needs a window. Pick 60s or longer to enable it.'}
          ${f.fairOpenSecs ? `<span class="opts tight" id="advRex" style="display:inline-flex;margin-left:6px">${[0, 100, 500, 1000].map((v) => `<button data-v="${v}" class="${v === f.allowRexUsd ? 'on' : ''}">${v ? '$' + v : 'off'}</button>`).join('')}</span>` : ''}</div></div>
      <div class="field"><label>Per-wallet cap <span class="dim">first 60 seconds after the clear</span></label>
        <div class="opts tight" id="advCap">${[0, 0.005, 0.01, 0.02].map((v) => `<button data-v="${v}" class="${v === f.walletCap ? 'on' : ''}">${v ? (v * 100).toFixed(1) + '%' : 'off'}</button>`).join('')}</div></div>
      <div class="field"><label>Decaying fee <span class="dim">extra quote fee for 60s after the clear, decaying to zero — paid to the vault or burned, never to you</span></label>
        <div class="opts tight" id="advDecay">${[0, 100, 200, 500].map((v) => `<button data-v="${v}" class="${v === f.decayFeeBps ? 'on' : ''}">${v ? (v / 100).toFixed(0) + '%' : 'off'}</button>`).join('')}</div>
        ${f.decayFeeBps ? `<div class="hint">Goes to: <span class="opts tight" id="advDecayTo" style="display:inline-flex;margin-left:6px">${[['vault', 'the vault'], ['burn', 'the burn']].map(([v, l]) => `<button data-v="${v}" class="${v === f.decayTo ? 'on' : ''}">${l}</button>`).join('')}</span></div>` : ''}</div>
      <div id="advSum">${sumBar()}</div>`;
  };

  // ⛔ DECLARED BEFORE THE TEMPLATE THAT CALLS IT. These were below the innerHTML assignment,
  // and a `const` is in its temporal dead zone until its own line runs — so building the form
  // threw "Cannot access 'devPresets' before initialization" and /create rendered a BLANK PAGE.
  // Nothing caught it: every test here reads the source as text, and the string was present.
  /**
   * ⛔ THE DEV BUY IS DENOMINATED IN THE PAIR ASSET, NOT IN SOL.
   * A launcher who read "dev buy" as SOL and typed 0.5 against a REX pair was asking for 0.5 REX
   * — about a fiftieth of a cent — and a launcher who typed what they meant in SOL against a token
   * they did not hold got a wallet prompt and then `TransferChecked / insufficient funds` out of
   * Meteora. Both are the same missing sentence: say which asset this is, and say how much of it
   * they have. `heldQuote` is the real on-chain balance; paper balances are SIM-only and empty here.
   */
  /**
   * ⛔ PRESETS ARE PRICED IN DOLLARS AND SHOWN IN THE PAIR ASSET, because the pair is what the pool
   * charges and the two are nothing alike: $100 is 0.5 SOL or roughly 720,000 REX. A fixed ladder
   * of raw numbers would be absurd on one pair and ruinous on another, and "0.5" against a REX pair
   * is how the very first dev buy ended up asking for a fiftieth of a cent.
   * Falls back to a bare "None" when the pair has no price, rather than inventing a ladder.
   */
  const DEV_USD = [0, 25, 100, 250];
  const devPresets = () => {
    const u = usdOf(f.quote);
    if (!(u > 0)) return [{ amt: 0, usd: 0 }];
    // ⛔ Each preset carries the dollar figure it was BUILT FROM, not one recomputed from the
    // rounded pair amount. Recomputing produced "$100.5" and "$251.2" — numbers that look like
    // precision and are actually rounding debris, on a control whose whole job is to be legible.
    // toPrecision(2) via Number() also drops the trailing zeros that made 0.21 render as "0.2100".
    return DEV_USD.map((d) => (d ? { amt: Number((d / u).toPrecision(2)), usd: d } : { amt: 0, usd: 0 }));
  };
  const devqHtml = () => devPresets().map(({ amt, usd }) =>
    `<button data-v="${amt}" class="${String(amt) === String(Number(f.devBuy) || 0) ? 'on' : ''}">${amt === 0 ? 'None' : amt}<small>${amt === 0 ? 'bots go first' : `${h(f.quote)} · ${fmtUsd(usd)}`}</small></button>`).join('');
  /**
   * ⛔ THE CHIPS ARE REBUILT WHEN THE PAIR CHANGES, not only when the form is first drawn. They are
   * priced in the pair asset, so after switching from SOL to REX they went on offering 0.21 / 0.83 /
   * 2.1 SOL — the right dollar amounts for the wrong asset, beside a field that had correctly
   * re-priced itself to 180,000 REX. Two numbers on screen disagreeing about the same choice is how
   * the launcher ends up typing the wrong one.
   */
  function paintDevq() {
    const box = $('#devq', root); if (!box) return;
    box.innerHTML = devqHtml();
    $$('#devq button', root).forEach((b) => b.onclick = () => {
      f.devBuy = b.dataset.v === '0' ? '' : b.dataset.v;
      const i = $('#fDev', root); if (i) i.value = f.devBuy;
      syncDevq(); devHintText($('#devHint', root)); prev();
    });
  }


  root.innerHTML = `<div class="fade"><div class="sec" style="margin-top:4px"><div><h1 style="font-size:34px">Launch a coin</h1><p class="muted" style="margin-top:6px">No launch fee. Pick your pair, choose the open, split the fee. The ceiling is 5% and the sum is on screen before you sign.</p></div><div>${gateChip()}</div></div>
    <div class="form"><div class="panel pad">
      <div class="two"><div class="field"><label>Name</label><input id="fName" maxlength="32" placeholder="Molten Cat"></div><div class="field"><label>Ticker</label><input id="fSym" maxlength="10" placeholder="MOLT" style="text-transform:uppercase"></div></div>
      <div class="field"><label>Image <span class="dim">required · png / jpg / webp / gif · ≤1.8 MB</span></label><div class="drop" id="drop"><div><div class="ic-lg">${icon('image')}</div><div>Drop an image or click to upload</div><div class="hint">Square looks best</div></div><input type="file" accept="image/*" id="fImg"></div></div>
      <div class="field"><label>Description</label><textarea id="fDesc" maxlength="600" placeholder="What is this coin, and why should anyone hold it?"></textarea></div>
      <div class="field"><label>Pair <span class="dim">what people buy it with, and what your holders get paid in</span></label>
        <div class="tabs big" id="ctabs">${TABS.map((t) => `<button data-t="${t.key}" class="${t.key === tab ? 'on' : ''}">${t.label}</button>`).join('')}</div>
        <div id="ctab">${tabBody()}</div></div>
      <!-- ⛔ THE FAIR OPEN CONTROL IS NOT SHOWN ON THE METEORA VENUE, BECAUSE THERE IS NO FAIR OPEN
           THERE. launchOnMeteora never sends fairOpenSecs and the DBC build route does not take
           it, so every dbc token on chain has fairOpenSecs=0 — yet this field rendered regardless,
           defaulted to "60s · recommended", and promised "sealed, one clearing price — nobody fills
           block zero". That is a guarantee the venue does not make. Julz launched, trusted it,
           went to buy his own coin and found bots had already filled block zero. He was not
           careless; he was told the opening was sealed. A control that does nothing is bad; one
           that does nothing while promising snipe protection costs people the opening of their own
           launch. On DBC the first buy in the pool-creation transaction is the real guarantee. -->
      ${S.venue === 'dbc' ? `
      <div class="field"><label>${icon('scales')}Your opening buy <span class="dim">rides inside the pool-creation transaction — nothing can buy before it</span></label>
        <div class="opts" id="devq">${devqHtml()}</div>
        <div class="hint" id="devHint2" style="margin-top:8px"></div></div>`
      : `<div class="field"><label>${icon('scales')}Fair Open window <span class="dim">sealed, one clearing price — nobody fills block zero</span></label><div class="opts" id="fos">${(S.fairOpenChoices || [0, 60, 120, 300]).map((v) => { const L = { 0: ['Instant', 'degens only'], 60: ['60s', 'recommended'], 120: ['2 min', 'bigger raise'], 300: ['5 min', 'community'] }[v] || [v + 's', '']; return `<button data-v="${v}" class="${v === f.fairOpenSecs ? 'on' : ''}">${L[0]}<small>${L[1]}</small></button>`; }).join('')}</div></div>`}
      <div class="field"><label>${icon('rex')}Holder rewards <span class="dim">quote asset, swaps only, paid every epoch ${f.rewardMode === 'hold' ? 'by balance × hold time' : 'pro-rata to balance'} · 1–3% in half-point steps</span></label>${stepRow('holders', f.holderBps, HOLDER_RANGE, 300)}</div>
      <!-- On the FRONT screen, not buried in Advanced: this is the thing that makes a launch here
           different from a launch anywhere else, so it is shown to everyone who launches rather
           than to the few who go looking. Same control, same numbers, rendered from shareField. -->
      <div class="field"><label>${icon('link')}Share &amp; earn <span class="dim">every holder becomes a distributor — how much of YOUR OWN cut goes to whoever brings the volume · costs holders nothing</span></label>
        <div id="frontShare">${shareField('frontRefShare')}</div></div>
      <div id="frontSum">${sumBar()}</div>
      <div class="two"><div class="field"><label>${S.venue === 'dbc' ? 'Opening buy' : 'Dev buy'} <span class="dim" id="devUnit">${S.venue === 'dbc' ? 'in the launch transaction' : 'optional'}</span></label><input id="fDev" inputmode="decimal" placeholder="0"><div class="hint" id="devHint"></div></div><div class="field"><label>Website</label><input id="fWeb" placeholder="https://"></div></div>
      <div class="two"><div class="field"><label>Twitter / X</label><input id="fX" placeholder="https://x.com/…"></div><div class="field"><label>Telegram</label><input id="fTg" placeholder="https://t.me/…"></div></div>
      <button class="btn cta lg" id="launch" style="width:100%"><span>${S.me ? 'Launch on REX Chain' : 'Connect wallet to launch'}</span></button>
      <div class="hint" style="margin-top:10px;text-align:center">No launch fee, and no platform fee on top — what you set above is the whole take. ${S.venue === 'dbc' ? 'Your opening buy is executed in the same transaction that creates the pool, so it cannot be front-run.' : 'Your dev buy goes through the Fair Open at the same price as everyone else.'}<br><span class="dim">Keep about <b>0.035 SOL</b> in your wallet for Solana's rent on the mint, its metadata and the pool accounts. That is the network's charge, not ours.</span></div>
    </div>
    <div class="preview"><div class="hint" style="margin-bottom:8px">Live preview</div><div id="prev"></div><div class="panel pad" style="margin-top:12px"><h3>What happens next</h3>${S.venue === 'dbc' ? `<ol class="hint" style="margin:8px 0 0 16px;padding:0;line-height:1.7"><li>One transaction creates the pool and makes your opening buy, in that order, atomically. Nothing can buy before you.</li><li>You land on your coin's page with the contract address and a buy box ready.</li><li>It is tradeable and indexed from the first swap — here, and anywhere that reads Meteora.</li><li>Every swap pays holders in the pair asset. At the migration threshold it graduates to an AMM with burned LP.</li></ol>` : `<ol class="hint" style="margin:8px 0 0 16px;padding:0;line-height:1.7"><li>Your coin appears in the <b>Fair Opens</b> rail with a countdown.</li><li>Bids (yours included) are escrowed. At the bell they clear as one buy at one price.</li><li>Trading opens on the curve. The first epoch is short, and it pays what was collected — ${f.rewardMode === 'hold' ? 'split by balance × how long each holder has held' : 'pro-rata to balance'}.</li><li>At the raise target it graduates price-continuously to a burned-LP AMM.</li></ol>`}</div></div></div></div>`;
  const prev = () => { $('#prev', root).innerHTML = tokenCard({ mint: 'preview', name: f.name || 'Your coin', symbol: f.symbol || 'TICK', image: f.image, creator: S.me?.wallet || '11111111111111111111111111111111', createdAt: Date.now(), holders: 0, status: f.fairOpenSecs ? 'fairopen' : 'live', fairOpenSecs: f.fairOpenSecs, fairOpenEnds: Date.now() + f.fairOpenSecs * 1000, fairOpenTotal: Number(f.devBuy) || 0, fairOpenBidders: Number(f.devBuy) > 0 ? 1 : 0, taxBps: sum(),
    fees: { holderBps: f.holderBps, creatorBps: f.creatorBps, vaultBps: f.vaultBps, burnBps: f.burnBps, buybackBps: f.buybackBps, totalBps: sum() },
    quote: f.quote, mcapUsd: 30 / 1.073e9 * 1e9 * (85.0054 * usdOf('SOL') / 85.0054) * (usdOf(f.quote) / usdOf(f.quote) || 1) * 1, chg5m: 0, yieldPaid: 0, progress: 0, raised: 0, raiseTarget: 85.0054 * usdOf('SOL') / (usdOf(f.quote) || 1), spark: [] }).replace('href="/t/preview" data-link', ''); const dh = $('#devHint', root); devHintText(dh); };
  let heldQuote = null;            // { spendable, total, decimals } in whole units, or null = unknown
  function devHintText(dh) {
    if (!dh) return;
    const sym = f.quote, want = Number(f.devBuy) || 0;
    const base = f.fairOpenSecs
      ? `Escrowed into the Fair Open · same clearing price as every other bidder · capped at 20% of the raise, same as every bidder`
      : `Executed as the first buy the moment you launch`;
    const unit = $('#devUnit', root); if (unit) unit.textContent = want > 0 ? `in ${sym}` : 'optional';
    // Only ever a plain sentence when we do not KNOW the balance. A dash-free "you hold 0" that is
    // really "the RPC did not answer" would send people off to buy a token they already own.
    if (want > 0 && heldQuote && want > heldQuote.spendable) {
      const short = want - heldQuote.spendable;
      dh.className = 'hint warn';
      // ⛔ OFFER THE WAY OUT, not just the problem. "You are short" with no next step is what sent
      // launchers away to find the pair asset elsewhere. The button buys the difference with SOL.
      const canBuy = sym !== 'SOL' && (usdOf(sym) || 0) > 0 && (usdOf('SOL') || 0) > 0;
      // ⛔ "CONSOLIDATE IT" WAS TRUE AND USELESS. Fco held 0.0584 TSLAx, none of it in the account
      // the pool draws on, and the form told him to fix that without giving him any way to. The
      // money was right there. It is one transfer per stray account, so it is a button.
      const scattered = heldQuote.total > heldQuote.spendable;
      dh.innerHTML = (scattered
        ? `<span>You hold ${fmtNum(heldQuote.total)} ${h(sym)}, but only ${fmtNum(heldQuote.spendable)} is in the account the pool can draw on.</span>`
          + ` <button class="btn sm topup" id="devConsolidate"><span>Move it into that account</span></button>`
        : heldQuote.spendable === 0
          ? `<span>Paid in ${h(sym)}${sym === 'SOL' ? '' : ' — not SOL'} — and you hold no ${h(sym)}.</span>`
          : `<span>You hold ${fmtNum(heldQuote.spendable)} ${h(sym)} — ${fmtNum(short)} short.</span>`)
        + (canBuy && !scattered ? ` <button class="btn sm topup" id="devTopUp"><span>Buy ${fmtNum(short)} ${h(sym)} with SOL</span></button>` : '');
      const cns = $('#devConsolidate', root);
      if (cns) cns.onclick = async () => {
        cns.disabled = true; const lbl = cns.firstChild;
        try {
          lbl.textContent = 'Building…';
          const built = await api('/api/chain/consolidate', { wallet: S.me.wallet, mint: quoteOf(f.quote).mint });
          lbl.textContent = 'Confirm in your wallet';
          const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
          const tx = web3.Transaction.from(Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0)));
          const signed = await CHAIN.signTx(tx);
          lbl.textContent = 'Sending…';
          await api('/api/chain/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
          toast('gold', `Moved your ${h(sym)} into the account the pool draws on`);
          // Re-read rather than assume: the figure the form trusts has to come from the chain.
          await refreshHeld(); devHintText($('#devHint', root));
        } catch (e) { toast('red', niceErr(e)); cns.disabled = false; lbl.textContent = 'Move it into that account'; }
      };
      const tu = $('#devTopUp', root);
      if (tu) tu.onclick = async () => {
        tu.disabled = true; const label = tu.firstChild;
        try { await topUpOpeningBuy((t) => { label.textContent = t; }); }
        catch (e) { toast('err', niceErr(e)); }
        tu.disabled = false; devHintText($('#devHint', root));
      };
      return;
    }
    dh.className = 'hint';
    const have = heldQuote ? ` · you hold ${fmtNum(heldQuote.spendable)} ${sym}` : '';
    dh.textContent = want > 0 ? `${fmtNum(want)} ${sym}${have} · ${base}` : `${base}. Paid in ${sym}${sym === 'SOL' ? '' : ', not SOL'}${have}`;
    // The opening-buy control says what the choice COSTS you, since the default costs the opening.
    const dh2 = $('#devHint2', root);
    if (dh2) {
      dh2.className = want > 0 ? 'hint' : 'hint warn';
      // ⛔ THE STATIC SENTENCE GETS ITS OWN ELEMENT so ES mode can translate it. Translation matches
      // WHOLE text nodes, and a node containing an interpolated ticker or balance is a different
      // string every time — it can never match a key. Written as one textContent, this hint sat in
      // English under a Spanish label. Splitting the fixed words out is what makes them reachable.
      dh2.innerHTML = want > 0
        ? `<b>${h(String(fmtNum(want)))} ${h(sym)}</b> (${h(String(fmtUsd(want * usdOf(sym))))}) <span>is bought in the same transaction that creates the pool, at the opening price.</span>${h(have)}`
        : `<span>With no opening buy, the first trade on your coin belongs to whoever sees the pool first — which is a bot.</span> <span class="dim"><span>Paid in</span> ${h(sym)}${sym === 'SOL' ? '' : '<span>, not SOL</span>'}${h(have)}</span>`;
    }
  }
  /**
   * Buy whatever the opening buy is short of, with SOL, inside the launch flow.
   *
   * Elio, 5 Oct: "if they need supply for the dev buy, allow auto-buy inside the UI to whatever
   * currency they need, all in 1-click". Before this the launcher was told to go and buy the pair
   * asset somewhere else and come back — which, for a REX pair, meant leaving to find REX, and is
   * where most of them simply stopped.
   *
   * ⛔ JUPITER IS EXACT-IN ONLY, so the shortfall cannot be bought precisely. It is priced through
   * USD and bought with headroom; a swap that lands slightly under is worse than useless because
   * the launch then fails for the same reason a second time. The balance is re-read from chain
   * afterwards rather than assumed from the quote.
   *
   * Returns true when there is enough to launch, false when the user cancelled or it fell short.
   */
  async function topUpOpeningBuy(stage = () => {}) {
    const want = Number(f.devBuy) || 0;
    if (!(want > 0)) return true;
    await refreshHeld();
    if (!heldQuote) return true;                  // balance unknown — let the server's guard speak
    const short = want - heldQuote.spendable;
    if (short <= 1e-9) return true;

    const sym = f.quote, q = quoteOf(sym);
    if (sym === 'SOL') {                          // nothing to swap INTO: SOL is what you would pay with
      toast('err', `Add ${fmtNum(short)} more SOL to this wallet, or lower the opening buy.`);
      return false;
    }
    const need = short * 1.04;                    // headroom for slippage and the price moving mid-swap
    const usdNeed = need * (usdOf(sym) || 0), solUsd = usdOf('SOL') || 0;
    if (!(usdNeed > 0) || !(solUsd > 0)) { toast('err', `No price for ${sym} right now — try again in a moment.`); return false; }
    const solIn = usdNeed / solUsd;

    stage(`Buying ${sym}…`);
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const lamports = Math.floor(solIn * 1e9);
    const quoted = await api('/api/jup/quote', {
      inputMint: SOL_MINT, outputMint: q.mint, amount: lamports, slippageBps: 100,
      userPublicKey: S.me.wallet,
    });
    const out = Number(quoted.quote?.outAmount || 0) / 10 ** (q.decimals ?? 6);
    if (!(out > 0)) { toast('err', `Could not route SOL into ${sym}.`); return false; }

    const built = await api('/api/jup/swap', { quoteResponse: quoted.quote, userPublicKey: S.me.wallet });
    const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
    // Jupiter returns a VERSIONED transaction; the legacy parser cannot read one.
    const tx = web3.VersionedTransaction.deserialize(Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0)));
    const signed = await CHAIN.signTx(tx);
    stage('Buying…');
    await api('/api/jup/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
    toast('ok', `Bought ${fmtNum(out)} ${h(sym)} for ${fmtNum(solIn)} SOL`);

    // ⛔ Re-read from chain. The amount that actually landed is not the amount quoted, and the
    // launch is about to be refused on the real balance rather than on our estimate of it.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      await refreshHeld();
      if (heldQuote && heldQuote.spendable >= want) return true;
    }
    toast('err', `The swap landed but ${sym} has not settled yet — press Launch again in a moment.`);
    return false;
  }

  async function refreshHeld() {
    heldQuote = null;
    const q = quoteOf(f.quote); if (!q || !S.me?.wallet || !CHAIN.on()) return devHintText($('#devHint', root));
    try {
      const r = await fetch(`/api/chain/held?wallet=${S.me.wallet}&mint=${q.mint}`).then((x) => x.json());
      if (!r.unknown) { const d = 10 ** (r.decimals ?? q.decimals ?? 6); heldQuote = { spendable: Number(r.spendable) / d, total: Number(r.total) / d }; }
    } catch (e) { /* unknown stays unknown */ }
    devHintText($('#devHint', root));
  }
  refreshHeld();
  const bind = (id, k, tf = (v) => v) => { $(id, root).oninput = (e) => { f[k] = tf(e.target.value); prev(); }; };
  bind('#fName', 'name'); bind('#fSym', 'symbol', (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '')); bind('#fDesc', 'description'); bind('#fDev', 'devBuy'); $('#fDev', root).addEventListener('input', () => { syncDevq(); devHintText($('#devHint', root)); }); bind('#fWeb', 'website'); bind('#fX', 'twitter'); bind('#fTg', 'telegram');
  // The sum is live on BOTH screens, so every control that moves it repaints both.
  const paintSum = () => { for (const id of ['#frontSum', '#advSum']) { const el = $(id, root); if (el) el.innerHTML = sumBar(); }
    const b = $('#launch', root); if (b) { b.classList.toggle('bad', !legal()); b.disabled = !legal(); } };
  // The pair buttons carry data-q and the fee buttons data-v; a picker that only knew about one of
  // them set f.quote to undefined the moment anyone chose a pair, and the launch 400'd.
  const pick = (sel, set) => $$(sel + ' button', root).forEach((b) => b.onclick = () => {
    if (b.classList.contains('blocked')) return;
    set(b.dataset.v !== undefined ? b.dataset.v : b.dataset.q);
    // Creator, the decaying fee and Share & earn all re-render the row from inside `set`, because
    // each one changes what the rows below it are allowed to say. That throws away every button this
    // closure is holding, so the identity check below matched nothing and stripped the selection off
    // the fresh markup — the click took effect but nothing lit up. The re-rendered row already
    // carries the right button marked, so only paint by hand when these nodes are still on screen.
    if (b.isConnected) $$(sel + ' button', root).forEach((x) => x.classList.toggle('on', x === b));
    paintSum(); prev();
  });
  /**
   * Share & earn lives on two screens, so it repaints on two screens and re-binds on both after.
   *
   * ⛔ REPAINT BOTH, ALWAYS — never just the one that was clicked. The front copy and the Advanced
   * copy read the same `f.refShareBps`, so a repaint of one leaves the other quoting the launcher a
   * percentage of their own cut that is no longer true. The Advanced copy also moves on its own
   * when the creator cut changes (0% removes the control entirely), and that is reached from a
   * different control on a different screen.
   *
   * ⛔ AND RE-BIND AFTER EVERY PAINT. `pick` captures the buttons it is handed; innerHTML throws
   * them away, so a repaint without a re-bind leaves a row that looks live and does nothing.
   */
  const paintShare = () => {
    const front = $('#frontShare', root); if (front) front.innerHTML = shareField('frontRefShare');
    const adv = $('#advShare', root); if (adv) adv.innerHTML = shareField('advRefShare');
    for (const id of ['#frontRefShare', '#advRefShare']) pick(id, (v) => { f.refShareBps = Number(v); paintShare(); });
    // One click out of the dead end: give the creator a cut and turn sharing on with it. Found by
    // attribute because both copies can render it, and an id may not repeat in a document.
    $$('[data-refquick]', root).forEach((b) => b.onclick = () => {
      f.creatorBps = Math.min(FM.sideMaxBps, 100); if (!f.refShareBps) f.refShareBps = 5000; bindTab(); prev();
    });
  };
  /**
   * The rule's own settings, and the sentence that describes them.
   *
   * ⛔ THE SENTENCE IS FETCHED, NOT COMPOSED HERE. The same function that builds the on-chain
   * instruction writes it, so what the launcher reads before signing and what the rule actually
   * does cannot drift apart. Re-describing the rule in the browser would be a second description
   * of the same thing, and the first time they disagreed the screen would be the lie.
   */
  let rpSeq = 0;
  const refreshRuleSummary = async () => {
    const el = $('#rpSummary', root); if (!el || !f.hook || f.hook === 'none') return;
    const mine = ++rpSeq;
    try {
      const r = await api('/api/hooks/preview', { key: f.hook, params: f.hookParams || {} });
      if (mine !== rpSeq) return;        // a later keystroke already asked; its answer wins
      el.textContent = r.summary || '';
      el.classList.remove('bad');
    } catch (e) {
      if (mine !== rpSeq) return;
      el.textContent = niceErr(e);
      el.classList.add('bad');
    }
  };
  const wireRuleParams = () => {
    const box = $('#rpDetail', root); if (!box) return;
    const set = (k, v) => { f.hookParams = { ...(f.hookParams || {}), [k]: v }; };
    // A slider and its number box are two views of one setting; each updates the other.
    $$('[data-param]', box).forEach((el) => {
      const k = el.dataset.param;
      if (el.tagName === 'INPUT') {
        el.oninput = () => {
          const v = el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value;
          set(k, v);
          $$(`[data-param="${k}"]`, box).forEach((o) => { if (o !== el && o.tagName === 'INPUT') o.value = el.value; });
          const lab = box.querySelector(`.rp-fval[data-for="${k}"]`);
          if (lab) lab.textContent = `${el.value} ${lab.textContent.split(' ').slice(1).join(' ')}`.trim();
          clearTimeout(window.__rpT); window.__rpT = setTimeout(refreshRuleSummary, 180);
        };
      }
    });
    // A choice can reveal or hide other settings, so it redraws rather than patching in place.
    $$('.rp-opts', box).forEach((g) => g.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      set(g.dataset.param, b.dataset.v);
      bindTab();
    });
    refreshRuleSummary();
  };

  const bindTab = () => {
    $('#ctab', root).innerHTML = tabBody();
    // Published so the devnet banner's faucet hands out THIS asset. Without it the button only ever
    // minted the default quote, which is why every tab but Quote was launchable and untradeable.
    // Changing the pair changes which asset the dev buy is spent in, so the balance behind the hint
    // has to be re-read — otherwise the form keeps quoting the previous pair's balance at you.
    // ⛔ THE OPENING BUY IS RE-PRICED WHEN THE PAIR CHANGES. It is denominated in the pair asset, so
    // a figure picked against one pair is meaningless against another: 0.21 SOL carried over to a REX
    // pair becomes "0.21 REX" — a fiftieth of a cent — and the launch is refused with "buy at least
    // 0.21 REX first", which is exactly what Julz hit. Carrying the DOLLAR value across keeps what
    // they meant; only the number changes.
    pick('#quotes', (v) => {
      const beforeUsd = (Number(f.devBuy) || 0) * (usdOf(f.quote) || 0);
      f.quote = v; window.__rexQuote = v;
      const nowPrice = usdOf(v) || 0;
      if (beforeUsd > 0 && nowPrice > 0) {
        f.devBuy = String(Number((beforeUsd / nowPrice).toPrecision(2)));
        const i = $('#fDev', root); if (i) i.value = f.devBuy;
      }
      refreshHeld(); bindTab(); paintDevq(); devHintText($('#devHint', root));
    });
    pick('#advCreator', (v) => { f.creatorBps = Number(v); if (f.creatorBps === 0) f.refShareBps = 0; bindTab(); });
    pick('#advVault', (v) => { f.vaultBps = Number(v); });
    pick('#advMode', (v) => { f.rewardMode = v; bindTab(); });
    // Picking a rule clears the previous rule's settings — carrying them over would silently apply
    // "0.25" from a sell cap as "0.25" of something else entirely.
    pick('#hookPick', (v) => { f.hook = v; f.hookParams = null; bindTab(); });
    wireRuleParams();
    pick('#advPgCat', (v) => { pgCat = v; bindTab(); });
    pick('#advPg', (v) => {
      const pg = PROGRAMS_ON.find((x) => x.key === v);
      // A program writes the ordinary fields and nothing more, so picking one then editing a field
      // leaves the edit standing — the preset is a starting point, not a mode you are locked into.
      //
      // ⛔ WHICH IS WHY EVERY PRESET NAMES `payoutAssets`, even the twelve that do not use one.
      // Object.assign only writes the keys a preset carries, so a basket left over from "Earn WIF"
      // would survive a switch to "Whale Club" and that coin would quietly pay WIF. A leftover
      // `payoutRule` is a starting point; a leftover basket changes what holders are handed.
      if (pg) { f.program = v; Object.assign(f, pg.set); }
      bindTab();
    });
    $$('#advPayAssets button', root).forEach((b) => b.onclick = () => {
      const sym = b.dataset.v;
      const cur = Array.isArray(f.payoutAssets) ? f.payoutAssets.map((l) => l.asset) : [];
      const next = cur.includes(sym) ? cur.filter((x) => x !== sym) : [...cur, sym].slice(0, PAYOUT_MAX_LEGS);
      // null, not [], when the last one is switched off: the column means "paid in the quote asset"
      // when it is empty, and `normalizeBasket` refuses an empty array outright.
      f.payoutAssets = splitEven(next);
      bindTab();
    });
    pick('#advBurn', (v) => { f.burnBps = Number(v); bindTab(); });
    pick('#advBuyback', (v) => { f.buybackBps = Number(v); bindTab(); });
    pick('#advRex', (v) => { f.allowRexUsd = Number(v); });
    pick('#advCap', (v) => { f.walletCap = Number(v); });
    pick('#advDecay', (v) => { f.decayFeeBps = Number(v); bindTab(); });
    pick('#advDecayTo', (v) => { f.decayTo = v; });
    const al = $('#advAllow', root); if (al) al.oninput = (e) => { f.allowlist = e.target.value; };
    // Both Share & earn copies, bound and painted here: the Advanced one has just been re-rendered
    // by this very function, and the front one has to follow whatever the creator cut just did.
    paintShare();
    paintSum();
  };
  $$('#ctabs button', root).forEach((b) => b.onclick = () => { tab = b.dataset.t; $$('#ctabs button', root).forEach((x) => x.classList.toggle('on', x === b)); bindTab(); });
  pick('#holders', (v) => { f.holderBps = Number(v); });
  $$('#fos button', root).forEach((b) => b.onclick = () => { f.fairOpenSecs = Number(b.dataset.v); $$('#fos button', root).forEach((x) => x.classList.toggle('on', x === b)); if (tab === 'adv') bindTab(); prev(); });
  // The opening-buy presets and the text field are the SAME value; typing in one must light the other.
  const syncDevq = () => $$('#devq button', root).forEach((x) => x.classList.toggle('on', String(x.dataset.v) === String(Number(f.devBuy) || 0)));
  $$('#devq button', root).forEach((b) => b.onclick = () => { f.devBuy = b.dataset.v === '0' ? '' : b.dataset.v; const i = $('#fDev', root); if (i) i.value = b.dataset.v === '0' ? '' : b.dataset.v; syncDevq(); devHintText($('#devHint', root)); prev(); });
  syncDevq();
  bindTab();
  const drop = $('#drop', root), fi = $('#fImg', root);
  const readFile = (file) => { if (!file || !file.type.startsWith('image/')) return; if (file.size > 1_800_000) return toast('err', 'Image too large (max 1.8 MB)'); const r = new FileReader(); r.onload = () => { f.image = r.result; drop.innerHTML = `<img src="${f.image}">` + drop.querySelector('input').outerHTML; $('#fImg', root).onchange = (e) => readFile(e.target.files[0]); prev(); }; r.readAsDataURL(file); };
  fi.onchange = (e) => readFile(e.target.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over'); drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); };
  /**
   * Launch on Meteora DBC — the venue new coins go to.
   *
   * The reason this exists rather than our own curve: a coin here is indexed by DexScreener and
   * Jupiter from its first trade, and the pool fee stays claimable after graduation instead of
   * being burned with the LP. On our own curve a coin was invisible to every aggregator until it
   * graduated, and earned nothing afterwards.
   */
  async function launchOnMeteora(b) {
    const stage = (st) => { b.firstChild.textContent = st; };
    const q = quoteOf(f.quote);
    stage('Building…');
    // ⛔ ONE BUILD ROUTE, TWO VENUES. Meteora refuses a taxed quote mint, so $GP and the other four
    // go to Raydium's LaunchLab instead. The server branches after every guard rather than offering
    // a second route that would start without them.
    const venue = venueFor(f.quote);
    const built = await api('/api/chain/dbc/build', {
      wallet: S.me.wallet, quoteMint: q.mint, name: f.name, symbol: f.symbol, venue,
      poolFeeBps: f.poolFeeBps ?? 200, creatorSharePct: f.creatorSharePct ?? 50,
      initialMarketCap: 5_000, migrationMarketCap: 50_000,
      // ⛔ No quoteDecimals. The server reads it off the mint now — this figure used to come from
      // here, out of a table that had STONK at 6 when the chain says 9, and a STONK pair sized its
      // curve a thousand times too small.
      devBuy: Math.floor((Number(f.devBuy) || 0) * 10 ** (q.decimals ?? 6)),
      decayFromBps: f.decayFeeBps || null, decaySeconds: f.decayFeeBps ? 60 : 0,
      hook: venue === 'launchlab' ? null : f.hook,
      hookParams: venue === 'launchlab' ? {} : (f.hookParams || {}),
    });
    await api('/api/chain/meta', { wallet: S.me.wallet, mint: built.mint, name: f.name, symbol: f.symbol,
      description: f.description, image: f.image, website: f.website, twitter: f.twitter, telegram: f.telegram, rewardMode: f.rewardMode, aiMode: f.aiMode, payoutRule: f.payoutRule, payoutN: f.payoutN, payoutAssets: f.payoutAssets });

    // ⛔ Check the wallet is on the account this launch was BUILT for before asking for signatures.
    // A launch is two prompts; discovering the mismatch on the second is the worst possible moment.
    await CHAIN.signer();
    const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');

    // Each step carries its OWN co-signers — the config keypair signs the first transaction and the
    // mint keypair the second. Signing both with both is rejected.
    for (const [i, st] of built.steps.entries()) {
      stage(built.steps.length > 1 ? `Confirm ${i + 1} of ${built.steps.length}…` : 'Confirm in your wallet…');
      const tx = web3.Transaction.from(Uint8Array.from(atob(st.tx), (c) => c.charCodeAt(0)));
      for (const sk of st.signers) tx.partialSign(web3.Keypair.fromSecretKey(Uint8Array.from(atob(sk), (c) => c.charCodeAt(0))));
      const signed = await CHAIN.signTx(tx);
      stage('Sending…');
      await api('/api/chain/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
    }

    // ⛔ THE DEV BUY COMES AFTER THE RULE, AND ONLY FOR A HOOKED LAUNCH.
    //
    // A hooked coin cannot be transferred until the hook's extra-account-meta list exists, which is
    // what the "switch the rule on" step above writes — so the first buy cannot ride along in the
    // pool transaction. Bundling it is what failed for Julz with "Unable to resolve transfer-hook
    // remaining accounts", and worse, a pool created without the rule ever being switched on is a
    // coin nobody can trade at all. Unhooked launches are unchanged: their buy is still inside the
    // pool transaction, one prompt fewer.
    if (built.devBuyAfter && built.devBuyAfter !== '0') {
      stage('Opening buy…');
      try {
        await CHAIN.act('dbc-buy', { mint: built.mint, amountIn: Number(built.devBuyAfter), minimumAmountOut: 0 },
          { onStage: (st) => stage(st === 'signing' ? 'Confirm your opening buy…' : st === 'sending' ? 'Sending…' : 'Opening buy…') });
      } catch (e) {
        // ⛔ The coin is live and its rule is on; only the buy failed. Say exactly that, because
        // "launch failed" would send them to relaunch a coin that already exists.
        toast('err', `$${h(f.symbol)} launched and its rule is on — but the opening buy did not go through (${niceErr(e)}). Buy it from the coin page.`);
      }
    }

    // Recorded only after the pool exists on chain, so an abandoned prompt leaves no phantom coin.
    const done = await api(venue === 'launchlab' ? '/api/chain/ll/confirm' : '/api/chain/dbc/confirm', {
      wallet: S.me.wallet, mint: built.mint, pool: built.pool, config: built.config,
      name: f.name, symbol: f.symbol, image: f.image, description: f.description,
      website: f.website, twitter: f.twitter, telegram: f.telegram,
      quote: f.quote, quoteMint: q.mint,
      poolFeeBps: f.poolFeeBps ?? 200, creatorSharePct: f.creatorSharePct ?? 50,
      holderBps: f.holderBps, vaultBps: f.vaultBps, burnBps: f.burnBps, buybackBps: f.buybackBps,
      // ⛔ THIS LINE IS THE WHOLE "SHARE & EARN" FEATURE. It was never sent, so every coin launched
      // on the live venue came back with it at zero and its share panel told the launcher there was
      // nothing to pay a sharer out of — minutes after they had picked 25%.
      refShareBps: f.refShareBps,
      rewardMode: f.rewardMode, aiMode: f.aiMode,
      payoutRule: f.payoutRule, payoutN: f.payoutN, payoutAssets: f.payoutAssets,
    });
    toast('gold', venue === 'launchlab'
      ? `${icon('rex')}<b>$${h(f.symbol)}</b> is live on Raydium LaunchLab — the venue that takes $${h(f.quote)} as a pair`
      : `${icon('rex')}<b>$${h(f.symbol)}</b> is live on Meteora — tradeable and indexed from the first swap`, f.image);
    if (done?.links?.dexscreener) toast('ok', `Find it anywhere: <a href="${done.links.dexscreener}" target="_blank" rel="noopener">DexScreener</a>`);
    // ⛔ Hand the launcher their coin. Julz launched, then had to go hunting for the contract
    // address to buy his own token, and bots filled block zero while he looked. The page he
    // lands on already has a buy box and a Copy CA button — they are simply below the fold,
    // which on a phone is the same as not existing. This flag tells the coin page that this
    // visit is the end of a launch, so it can put both in front of him.
    try { sessionStorage.setItem('rexJustLaunched', built.mint); } catch {}
    history.pushState({}, '', `/t/${built.mint}`); dispatchEvent(new PopStateEvent('popstate'));
  }

  async function launchOnChain(b) {
    const stage = (st) => { b.firstChild.textContent = { building: 'Building…', checking: 'Checking…', signing: 'Confirm in your wallet…', sending: 'Sending…', done: 'Done' }[st] || st; };
    const q = quoteOf(f.quote);
    const raiseTarget = Math.floor((85.0054 * usdOf('SOL') / (q.usd || 1)) * 1e6);
    const vQuote0 = Math.floor(raiseTarget * 30 / 85.0054);
    // Metadata is saved against the mint the builder picks, so the card is complete the moment it lands.
    const built = await api('/api/chain/build/create', { wallet: S.me.wallet, quoteMint: q.mint, raiseTarget, vQuote0, holderBps: f.holderBps, creatorBps: f.creatorBps, vaultBps: f.vaultBps, burnBps: f.burnBps, buybackBps: f.buybackBps, fairOpenSecs: f.fairOpenSecs });
    await api('/api/chain/meta', { wallet: S.me.wallet, mint: built.mint, name: f.name, symbol: f.symbol, description: f.description, image: f.image, website: f.website, twitter: f.twitter, telegram: f.telegram, rewardMode: f.rewardMode });
    stage('signing');
    const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
    const tx = web3.Transaction.from(Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0)));
    const signed = await CHAIN.signTx(tx);
    stage('sending');
    const { signature } = await api('/api/chain/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
    toast('gold', `${icon('rex')}<b>$${h(f.symbol)}</b> is live on chain · <a href="${CHAIN.explorer(signature)}" target="_blank" rel="noopener">view tx</a>`, f.image);
    // ⛔ Hand the launcher their coin. Julz launched, then had to go hunting for the contract
    // address to buy his own token, and bots filled block zero while he looked. The page he
    // lands on already has a buy box and a Copy CA button — they are simply below the fold,
    // which on a phone is the same as not existing. This flag tells the coin page that this
    // visit is the end of a launch, so it can put both in front of him.
    try { sessionStorage.setItem('rexJustLaunched', built.mint); } catch {}
    history.pushState({}, '', `/t/${built.mint}`); dispatchEvent(new PopStateEvent('popstate'));
  }
  $('#launch', root).onclick = async () => { if (!S.me) return connectWallet(); if (!f.image) return toast('err', 'Add an image — every coin on REX Chain has one');
    // A belt-and-braces check on the pair: a picker bug here once sent `undefined` and every launch
    // came back "Unknown quote" with nothing on screen explaining why. Tolerates an unloaded state.
    if (S.quotes?.length && !S.quotes.some((q) => q.symbol === f.quote)) return toast('err', 'Pick a pair to launch against');
    if (!legal()) return toast('err', `${(sum() / 100).toFixed(1)}% is over the ${(CAP / 100).toFixed(0)}% ceiling`); const b = $('#launch', root); b.disabled = true; b.firstChild.textContent = 'Launching…';
    if (S.venue === 'dbc') {
      try {
        // ⛔ ONE CLICK. If the opening buy is more than they hold, buy the difference first and then
        // launch — rather than refusing and sending them off to find the pair asset somewhere else,
        // which is where most launchers simply stopped. Two wallet prompts, one button.
        const ok2 = await topUpOpeningBuy((t) => { b.firstChild.textContent = t; });
        if (!ok2) { b.disabled = false; b.firstChild.textContent = 'Launch on REX Chain'; return; }
        await launchOnMeteora(b);
      } catch (e) { toast('err', niceErr(e)); b.disabled = false; b.firstChild.textContent = 'Launch on REX Chain'; }
      return;
    }
    if (CHAIN.on()) { try { await launchOnChain(b); } catch (e) { toast('err', niceErr(e)); b.disabled = false; b.firstChild.textContent = 'Launch on REX Chain'; } return; } try { const r = await api('/api/tokens', { ...f, devBuy: Number(f.devBuy) || 0 }); toast('gold', `${icon('rex')}<b>$${h(r.token.symbol)}</b> is live${r.token.status === 'fairopen' ? ' — Fair Open running' : ''}`, r.token.image); history.pushState({}, '', `/t/${r.token.mint}`); dispatchEvent(new PopStateEvent('popstate')); } catch (e) { toast('err', niceErr(e)); b.disabled = false; b.firstChild.textContent = 'Launch on REX Chain'; } };
  prev();
  const off = bus.on('auth', () => { $('#launch span', root).textContent = S.me ? 'Launch on REX Chain' : 'Connect wallet to launch'; const gc = root.querySelector('.gate'); if (gc) gc.outerHTML = gateChip(); prev(); });
  return () => off();
}

// ============================================================ PROFILE
export async function profile(root, wallet) {
  const mine = S.me && (!wallet || wallet === S.me.wallet);
  // Only /me with nobody signed in needs a connect prompt. A PASTED wallet is a public record and
  // renders for anyone — that is the whole point: look without connecting.
  if (!mine && !wallet) {
    root.innerHTML = `<div class="empty">Connect your wallet to see your portfolio.<br><br>
      <button class="btn cta" id="cw"><span>Connect wallet</span></button>
      <div class="hint" style="margin-top:18px">Or look up any wallet without connecting:</div>
      <div class="field lookup" style="max-width:420px;margin:8px auto 0"><input id="lk" placeholder="paste a wallet address" spellcheck="false"></div>
      <div class="hint" id="lkerr" style="margin-top:6px;min-height:16px"></div></div>`;
    $('#cw', root).onclick = connectWallet;
    wireLookup(root);
    const off = bus.on('auth', (m) => { if (m) profile(root); });
    return () => off();
  }
  let p; try { p = mine ? await api('/api/me') : await api(`/api/profile/${wallet}`); } catch (e) { root.innerHTML = `<div class="empty">${h(niceErr(e))}</div>`; return () => {}; }
  // The sharer's record: what they brought, what it earned, and the one code they share everywhere.
  let rep = null; try { rep = await api(`/api/rep?w=${wallet || S.me.wallet}`); } catch {}
  const totalUsd = p.holdings.reduce((s, x) => s + x.valueUsd, 0);
  const R = rep?.reputation, CH2 = rep?.creator;
  const fmtPts = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n || 0).toString();
  const heldFor = (d) => d >= 1 ? `${Math.floor(d)}d` : d > 0 ? `${Math.max(1, Math.round(d * 24))}h` : '—';
  const rec = p.record || {}, pts = p.points || {};
  // The standings block. Shown for ANY wallet, which is what makes a pasted address worth pasting.
  const standing = `<div class="sec" style="margin-top:18px"><h2>${icon('trophy')}Standing</h2></div>
    <div class="panel pad"><div class="pme-grid">
      <div><div class="l">Points</div><div class="v gold">${fmtPts(pts.total)}</div>${p.rank ? `<div class="hint">rank #${p.rank}</div>` : '<div class="hint">unranked</div>'}</div>
      <div><div class="l">Held for</div><div class="v">${heldFor(rec.days)}</div>${rec.tier ? `<div class="hint">${h(rec.tier)}</div>` : ''}</div>
      <div><div class="l">Ever sold</div><div class="v">${rec.neverSold ? 'Never' : rec.soldAt ? 'Yes' : '—'}</div>
        ${rec.coins ? `<div class="hint">${rec.coins} coin${rec.coins === 1 ? '' : 's'} held</div>` : ''}</div>
    </div>
    ${(() => { const b = badgesFor(rec, pts.total); return b.length ? `<div class="pr-badges" style="margin-top:12px">${b.map((x) => `<span class="pb${x === 'Never sold' ? ' dia' : ''}">${h(x)}</span>`).join('')}</div>` : ''; })()}
    <div class="pbreak" style="margin-top:14px">${[['Holding', pts.holding], ['Buys', pts.buys], ['Volume', pts.volume], ['Launches', pts.launches],
      ['Graduations', pts.graduations], ['Fair Opens', pts.fairOpens], ['Rewards', pts.claims], ['Referrals', pts.referrals],
      ['Profile', pts.profile], ['Picture', pts.pfp]].filter(([, v]) => v > 0)
      .map(([k, v]) => `<span>${k}<b>${fmtPts(v)}</b></span>`).join('') || '<span class="muted">No points yet.</span>'}</div>
    </div>`;

  const repBlock = R ? `<div class="sec" style="margin-top:18px"><h2>${icon('link')}Growth record</h2></div>
    <div class="panel pad"><div class="replist" style="gap:10px 28px">
      <span>Buyers brought<b>${R.broughtBuyers}</b></span>
      <span>Creators brought<b>${R.broughtCreators}</b></span>
      <span>Volume brought<b>${fmtUsd(R.volumeUsd)}</b></span>
      <span>Earned sharing<b class="gold">${fmtUsd(R.earnedUsd)}</b></span>
      <span>Tokens backed<b>${R.tokensBacked}</b></span>
      <span>Epochs held through<b>${R.epochsSurvived}</b></span>
      ${CH2?.launches ? `<span>Launched<b>${CH2.launches}</b></span><span>Graduated<b>${CH2.graduated}</b></span><span>Paid to their holders<b class="gold">${fmtUsd(CH2.paidUsd)}</b></span>` : ''}
    </div>
    ${mine ? `<div class="reflink" style="margin-top:12px"><code>${location.origin}/?r=${R.code}</code><button class="btn sm" data-copy="${location.origin}/?r=${R.code}">copy</button></div>
      <div class="hint" style="margin-top:6px">Your platform link. Anyone who launches a coin after arriving through it earns you ${((S.gate?.creatorRefBps ?? 500) / 100).toFixed(0)}% of their creator cut, on every token they ever launch.</div>` : ''}
    </div>` : '';
  root.innerHTML = `<div class="fade">
    ${!mine && p.wallet ? `<div class="pubnote">Public record — anyone can read this without connecting.
      ${S.me ? '' : '<button class="btn sm" id="claim">This is my wallet</button>'}</div>` : ''}
    <div class="thead"><div class="av lg" style="display:grid;place-items:center;font-size:34px;background:linear-gradient(135deg,#1c1f2a,#0f1117);overflow:hidden">${p.avatar ? `<img src="${h(p.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()">` : icon(mine ? 'flame' : 'user')}</div><div><h1 style="font-size:30px">${h(p.name)}</h1>${p.bio ? `<p class="muted" style="margin-top:4px;max-width:46ch">${h(p.bio)}</p>` : ''}<div class="row wrap" style="margin-top:6px"><span class="mono muted">${p.wallet}</span><button class="btn sm" data-copy="${p.wallet}">copy</button>${mine ? '<a class="btn sm" href="/welcome" data-link>edit profile</a>' : ''}${p.x ? `<a class="btn sm" href="https://x.com/${encodeURIComponent(p.x)}" target="_blank" rel="noopener nofollow">@${h(p.x)}</a>` : ''}${p.telegram ? `<a class="btn sm" href="https://t.me/${encodeURIComponent(p.telegram)}" target="_blank" rel="noopener nofollow">tg</a>` : ''}${p.website ? `<a class="btn sm" href="${h(p.website)}" target="_blank" rel="noopener nofollow">site</a>` : ''}</div></div>
      <div class="price"><div class="big gold">${fmtUsd(p.yieldUsd)}</div><div class="sub">earned from holding · ${p.yieldPayouts} payouts</div></div></div>
    ${mine ? `<div class="sec"><h2>Balances</h2>${S.sim ? '<button class="btn sm" id="faucet">Top up paper funds</button>'
      : (CHAIN.on() && S.chain?.faucet ? `<button class="btn sm" id="cfaucet">Get ${S.chain.cluster} test funds</button>` : '')}</div><div class="bal" id="bal">${balTiles(p.balances)}</div>` : ''}
    <div class="sec"><h2>Holdings</h2><span class="muted">${fmtUsd(totalUsd)} across ${p.holdings.length} coins</span></div>
    ${/* ⛔ "HOW DO THESE HOLDINGS GET TRANSFERRED OUT TO A WALLET? I DON'T SEE AN OPTION FOR IT."
          Julz asked that, and the honest answer is that there is nothing to transfer: his own wallet
          signed every one of those buys, so the tokens have been in it the whole time. The table
          never said so and offered no action of any kind, which reads exactly like money held
          somewhere you cannot reach. Say where they are, and give the row the two things a holder
          actually wants to do with them. */ ''}
    ${mine && p.custody === 'wallet' && p.holdings.length ? `<div class="custody">${icon('vault')}<div><b>These are already in your wallet.</b> REX Chain never takes custody — every buy was signed by your own wallet, so the tokens sit in it and can be sent or sold from anywhere. Nothing here needs claiming.</div></div>` : ''}
    <div class="panel">${p.holdings.length ? `<table class="tbl"><tr><th>Coin</th><th class="r">Balance</th><th class="r">Value</th><th class="r">PnL</th><th>Tier</th><th class="r">Rewards earned</th>${mine ? '<th></th>' : ''}</tr>${p.holdings.map((x) => `<tr><td><a class="row" href="/t/${x.mint}" data-link>${av(x, 'sm')}<span><b>${h(x.name)}</b> <span class="muted">$${h(x.symbol)}</span>${x.isDev ? ' <span class="chip dev" style="height:18px;font-size:10px">dev</span>' : ''}</span></a></td><td class="r">${fmtNum(x.amount)}</td><td class="r">${fmtUsd(x.valueUsd)}<div class="dim" style="font-size:11px">${fmtQ(x.value, x.quote)}</div></td><td class="r ${x.pnl >= 0 ? 'up' : 'down'}">${x.pnl >= 0 ? '+' : ''}${fmtNum(x.pnl)} ${x.quote}<div class="dim" style="font-size:11px">${x.cost > 0 ? pct(x.pnl / x.cost) : ''}</div></td><td class="dim" style="font-size:12px">${x.heldSince ? ago(x.heldSince) : '—'}</td><td class="r gold">${x.yieldEarned > 0 ? fmtQ(x.yieldEarned, x.quote) : '—'}</td>${mine ? `<td class="r nowrap"><a class="btn xs" href="/t/${x.mint}?side=sell" data-link>Sell</a>${p.custody === 'wallet' ? ` <a class="btn xs ghost" href="https://solscan.io/token/${encodeURIComponent(x.mint)}?account=${encodeURIComponent(p.wallet)}" target="_blank" rel="noopener">On chain</a>` : ''}</td>` : ''}</tr>`).join('')}</table>` : '<div class="empty">No holdings yet.</div>'}</div>
    ${p.bids?.length ? `<div class="sec"><h2>Open Fair Open commitments</h2></div><div class="panel"><table class="tbl">${p.bids.map((b) => `<tr><td><a href="/t/${b.mint}" data-link><b>$${h(b.symbol)}</b></a></td><td class="r gold">${fmtQ(b.amount, b.quote)}</td><td class="dim">clears in ${mmss(b.fair_open_ends - Date.now())}</td></tr>`).join('')}</table></div>` : ''}
    <div class="two" style="margin-top:22px;align-items:start">
      <div><div class="sec" style="margin-top:0"><h2>Created</h2></div><div class="stack">${p.created.length ? p.created.map(tokenCard).join('') : '<div class="empty">No launches yet.</div>'}</div></div>
      ${standing}
      ${repBlock}
      <div><div class="sec" style="margin-top:0"><h2>Recent activity</h2></div><div class="panel"><table class="tbl">${[...p.payouts.map((x) => ({ ts: x.ts, html: `<td class="dim">${ago(x.ts)}</td><td>${icon('gem')}reward <b>$${h(x.symbol)}</b></td><td class="r gold">+${fmtQ(x.amount, x.quote)}</td>` })), ...p.recent.map((x) => ({ ts: x.ts, html: `<td class="dim">${ago(x.ts)}</td><td><span class="${x.side === 'buy' ? 'up' : 'down'}">${x.side}</span> <a href="/t/${x.mint}" data-link><b>$${h(x.symbol)}</b></a>${x.kind === 'fairopen' ? ` <span class="chip fair" style="height:18px;font-size:10px">${icon('scales')}fair</span>` : ''}</td><td class="r">${fmtNum(x.tokens)} for ${fmtQ(x.quote, x.quoteSymbol)}</td>` }))].sort((a, b) => b.ts - a.ts).slice(0, 40).map((r) => `<tr>${r.html}</tr>`).join('') || '<tr><td class="dim">Nothing yet.</td></tr>'}</table></div></div>
    </div></div>`;
  $$('[data-copy]', root).forEach((b) => b.onclick = () => { copyText(b.dataset.copy).then((ok) => toast(ok ? 'ok' : 'err', ok ? 'Copied' : 'Could not copy — select it and copy by hand')); });
  const fb = $('#faucet', root); if (fb) fb.onclick = async () => { const r = await api('/api/faucet', {}); $('#bal', root).innerHTML = balTiles(Object.entries(r.balances).map(([asset, amount]) => ({ asset, amount }))); S.me.balances = r.balances; bus.emit('auth', S.me); toast('ok', 'Paper funds topped up'); };
  // On a cluster the faucet is a real transaction: it mints the quote token to your own ATA and,
  // if you are short, sends enough SOL to pay rent and fees — otherwise you get tokens and then
  // fail at the first signature with a message about lamports.
  const cf = $('#cfaucet', root); if (cf) cf.onclick = async () => {
    cf.disabled = true; const was = cf.textContent; cf.textContent = 'Sending…';
    try {
      const r = await api('/api/chain/faucet', { wallet: S.me.wallet });
      toast('gold', `Sent ${fmtNum(r.amount)} test $REX${r.sol ? ` and ${r.sol.toFixed(3)} SOL` : ''} · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">view tx</a>`);
    } catch (e) { toast('err', niceErr(e)); }
    cf.disabled = false; cf.textContent = was;
  };
  // Editing reuses the welcome screen rather than a second, smaller form that would drift out of
  // sync with it — same fields, same validation, same NFT picker. Plain data-link, so it routes the
  // way every other internal link on the site does.
  // "This is my wallet" on someone else's page. Connecting is the ONLY thing that can prove it: a
  // pasted address is a claim anyone could make, and the board this feeds is exactly where the
  // incentive to impersonate lives. Reading stays free; owning costs one signature.
  const cl = $('#claim', root); if (cl) cl.onclick = async () => {
    try {
      const me = await connectWallet();
      if (!me) return;
      if (me.wallet === wallet) { history.pushState({}, '', '/welcome'); dispatchEvent(new PopStateEvent('popstate')); }
      else toast('err', 'That wallet signed in as ' + short(me.wallet) + ', so this profile is not yours to edit.');
    } catch (e) { toast('err', niceErr(e)); }
  };
  return () => {};
}
const balTiles = (b) => (b.length ? b : [{ asset: '—', amount: 0 }]).map((x) => `<div class="b"><div class="l">${h(x.asset)}</div><div class="v">${fmtNum(x.amount)}</div><div class="hint">${fmtUsd(x.amount * usdOf(x.asset))}</div></div>`).join('');

// ============================================================ LEADERBOARD
// ============================================================ BUILD
// The developer surface. Everything here is a real endpoint that is live right now — the page runs
// each example against the pad it is served from, so a broken promise shows up as a broken example.
const API_DOCS = [
  { m: 'GET',  p: '/api/tokens?sort=trending&limit=20', d: 'Every launch, with price, market cap, fee split and 24h stats. sort: new · trending · graduating · paid · volume · mcap. Filter with &quote=REX or &q=search.' },
  { m: 'GET',  p: '/api/tokens/:mint', d: 'One launch in full — buckets, holders, trades, the creator\'s record and the milestones it has crossed.' },
  { m: 'GET',  p: '/api/fairopens', d: 'Opens in flight right now, with the committed total and the clearing countdown.' },
  { m: 'GET',  p: '/api/feed', d: 'The live trade tape across every pair.' },
  { m: 'GET',  p: '/api/buys', d: 'Recent buys only, newest first, with the USD size and whether the buyer is new to the coin. <code>limit</code> up to 100, <code>min</code> filters by USD size.' },
  { m: 'POST', p: '/api/quote', d: 'Price a trade before it happens: { mint, side: "buy"|"sell", amount }. Returns the fee split bucket by bucket, price impact and what you would receive.' },
  { m: 'GET',  p: '/api/milestones', d: 'Milestones across the ecosystem, each with ready-to-post copy. Add ?mint= for one launch.' },
  { m: 'GET',  p: '/api/ref/top', d: 'Who is bringing the volume. Add ?mint= for one launch.' },
  { m: 'GET',  p: '/api/rep?w=:wallet', d: 'A wallet\'s public record: what they have brought, backed and launched.' },
  { m: 'GET',  p: '/api/leaderboard', d: 'Most rewards to holders, top earners, longest holds, top creators.' },
  { m: 'GET',  p: '/api/health', d: 'Liveness, token count, connected clients.' },
];

export async function build(root) {
  const base = location.origin;
  let tokens = [];
  try { tokens = (await api('/api/tokens?sort=trending&limit=40')).tokens; } catch {}
  let mint = tokens[0]?.mint || '', theme = 'dark', ref = null;
  try { if (S.me) ref = (await api('/api/ref/me')).summary.code; } catch {}

  const snippet = () => `<iframe src="${base}/embed/${mint}?theme=${theme}${ref ? `&r=${ref}` : ''}" width="340" height="230" style="border:0;border-radius:14px;overflow:hidden" loading="lazy" title="REX Chain token card"></iframe>`;

  root.innerHTML = `<div class="fade">
    <div class="eyelabel">Build</div>
    <h1 style="margin-top:10px;font-size:34px">The pad is the entry point.</h1>
    <p class="muted" style="font-size:15.5px;margin-top:10px;max-width:660px">Everything the site runs on is a public, unauthenticated read. No key, no signup, no rate-limit tier — point at it and build. The endpoints below are the same ones this page is using to render itself.</p>

    <div class="sec" style="margin-top:22px"><h2>${icon('puzzle')}Embed a live card</h2><span class="muted" style="font-size:12.5px">Drop it on your own site — it refreshes itself and sends traffic back attributed to you</span></div>
    <div class="two" style="align-items:start">
      <div class="panel pad">
        <div class="field"><label>Token</label>
          <select id="eTok">${tokens.map((t) => `<option value="${t.mint}" ${t.mint === mint ? 'selected' : ''}>$${h(t.symbol)} — ${h(t.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Theme</label><div class="opts tight" id="eTheme">${['dark', 'light'].map((x) => `<button data-v="${x}" class="${x === theme ? 'on' : ''}">${x}</button>`).join('')}</div></div>
        ${ref ? `<div class="hint">Your referral code <b>${h(ref)}</b> is baked into the snippet, so anyone who trades through your embed is credited to you.</div>`
               : `<div class="hint">Connect a wallet and your referral code is baked into the snippet automatically.</div>`}
        <div class="field" style="margin-top:12px"><label>Paste this anywhere</label>
          <textarea id="eSnip" rows="4" readonly style="font-family:var(--fm);font-size:11px">${h(snippet())}</textarea></div>
        <button class="btn sm" id="eCopy">Copy snippet</button>
      </div>
      <div class="panel pad"><div class="hint" style="margin-bottom:8px">Live preview</div><div id="ePrev"></div></div>
    </div>

    <div class="sec" style="margin-top:24px"><h2>${icon('bolt')}The API</h2><span class="muted" style="font-size:12.5px">Public reads, no auth</span></div>
    <div class="panel"><table class="tbl"><tr><th style="width:62px">Method</th><th>Endpoint</th><th>What it returns</th></tr>
      ${API_DOCS.map((e) => `<tr><td><span class="chip ${e.m === 'GET' ? 'conv' : ''}" style="height:18px;font-size:10px">${e.m}</span></td><td class="mono" style="font-size:12px">${h(e.p)}</td><td class="muted" style="font-size:12.5px">${e.d}</td></tr>`).join('')}
    </table></div>

    <div class="sec" style="margin-top:24px"><h2>Try it</h2></div>
    <div class="panel pad">
      <div class="row wrap" style="gap:6px;margin-bottom:10px">${API_DOCS.filter((e) => e.m === 'GET' && !e.p.includes(':')).map((e, i) => `<button class="btn sm" data-try="${h(e.p)}">${h(e.p.split('?')[0])}</button>`).join('')}</div>
      <pre id="tryOut" class="mono" style="margin:0;padding:12px;border-radius:11px;background:rgba(0,0,0,.35);border:1px solid var(--line);font-size:11.5px;max-height:320px;overflow:auto;white-space:pre-wrap">Pick an endpoint — it runs against this pad, live.</pre>
    </div>

    <div class="sec" style="margin-top:24px"><h2>Share cards</h2></div>
    <div class="panel pad"><p class="hint" style="margin:0 0 8px">Every launch has a generated card at <code class="mono">${base}/og/&lt;mint&gt;.png</code> with its live market cap, holder payout and fee split. Link to a token anywhere and it unfurls with that card — no work on your side.</p>
      <img src="${base}/og/${mint}" id="ogPrev" alt="" style="width:100%;max-width:520px;border-radius:12px;border:1px solid var(--line)">
    </div>

    <div class="sec" style="margin-top:24px"><h2>On chain</h2></div>
    <div class="panel pad"><div class="replist" style="gap:10px 28px">
      <span>Program<b class="mono" style="font-size:11px">${S.chain?.programId ? h(S.chain.programId) : 'paper mode — set RPC_URL'}</b></span>
      <span>Cluster<b>${S.chain?.cluster || 'demo'}</b></span>
      <span>Fee ceiling<b>${((S.fees?.capBps ?? 500) / 100).toFixed(0)}%</b></span>
    </div><p class="hint" style="margin-top:10px">The program is open source in the repo: the fee module, the sealed Fair Open, the reward epochs and the merkle claim rail. It is <b>unaudited</b> and on devnet — read it before you build anything that depends on it.</p></div>
  </div>`;

  const paint = () => {
    $('#eSnip', root).value = snippet();
    $('#ePrev', root).innerHTML = `<iframe src="${base}/embed/${mint}?theme=${theme}${ref ? `&r=${ref}` : ''}" width="340" height="230" style="border:0;border-radius:14px;max-width:100%" title="preview"></iframe>`;
    const og = $('#ogPrev', root); if (og) og.src = `${base}/og/${mint}.png?t=${Date.now()}`;
  };
  paint();
  $('#eTok', root).onchange = (e) => { mint = e.target.value; paint(); };
  $$('#eTheme button', root).forEach((b) => b.onclick = () => { theme = b.dataset.v; $$('#eTheme button', root).forEach((x) => x.classList.toggle('on', x === b)); paint(); });
  $('#eCopy', root).onclick = async () => { const ok = await copyText(snippet()); toast(ok ? 'ok' : 'err', ok ? 'Snippet copied' : 'Copy failed — select it by hand'); };
  $$('[data-try]', root).forEach((b) => b.onclick = async () => {
    const out = $('#tryOut', root); out.textContent = '…';
    try { const r = await fetch(b.dataset.try); const j = await r.json(); out.textContent = JSON.stringify(j, null, 2).slice(0, 4000); }
    catch (e) { out.textContent = 'failed: ' + niceErr(e); }
  });
  return () => {};
}

// ============================================================ GROW
// The growth layer's own surface. Until now a holder's link, their record and the milestones a token
// crossed were scattered across token pages — which is what made the ecosystem claim hollow.
export async function growth(root) {
  root.innerHTML = '<div class="fade"><div class="skeleton" style="height:140px;margin-bottom:12px"></div><div class="skeleton" style="height:300px"></div></div>';
  // ⛔ EVERY LEG CATCHES. A bare Promise.all rejects on the first failure, and with nothing rendered
  // yet that left the whole page blank — one slow endpoint taking out five panels that had no need
  // of it. The router now catches a page that throws, but a page that can show four of its five
  // sections should show them rather than hand the router an error.
  const [top, ms, mine, inviters, tree, callers] = await Promise.all([
    api('/api/ref/top').catch(() => ({ top: [] })),
    api('/api/milestones').catch(() => ({ milestones: [] })),
    S.me ? api('/api/rep').catch(() => null) : Promise.resolve(null),
    api('/api/ref/inviters').catch(() => ({ top: [] })),
    // The tree is per-wallet, so there is nothing to ask for until one is connected.
    S.me ? api(`/api/ref/tree?wallet=${S.me.wallet}`).catch(() => null) : Promise.resolve(null),
    api('/api/callouts/board?limit=20').catch(() => ({ board: [] })),
  ]);
  const R = mine?.reputation, hold = S.gate?.refHoldUsd || 0;
  const link = R ? `${location.origin}/?r=${R.code}` : null;

  root.innerHTML = `<div class="fade">
    <div class="eyelabel">Grow</div>
    <h1 style="margin-top:10px;font-size:34px">Every holder is a distributor.</h1>
    <p class="muted" style="font-size:15.5px;margin-top:10px;max-width:660px">A creator can hand part of their own cut to whoever brings the volume. It costs holders nothing and the fee ceiling nothing — it comes out of the creator's share, so the people who sell the coin are paid by the person who launched it.</p>

    ${/* ⛔ RANKED BY THE MEDIAN, NOT THE MEAN AND NOT THE BEST CALL. One 40x should not outrank
          thirty 2xs — the mean is the statistic a caller games by spraying, and "best call" is that
          taken to its limit. The median answers the only question a reader actually has. */ ''}
    ${callers?.board?.length ? `<div class="sec" style="margin-top:22px"><h2>${icon('megaphone')}Callers</h2><span class="muted">ranked by the median call, not the loudest one</span></div>
    <div class="panel"><table class="tbl"><tr><th>#</th><th>Caller</th><th class="r">Calls</th><th class="r">Median</th><th>Best</th><th class="r">Volume brought</th><th class="r">Earned</th></tr>
      ${callers.board.map((c, i) => `<tr><td class="dim">${i + 1}</td><td>${walletLink(c.wallet, c.name)}</td><td class="r">${c.calls}</td>
        <td class="r cb-x ${c.medianX == null ? 'dim' : c.medianX >= 1.5 ? 'up' : c.medianX < 0.8 ? 'down' : ''}">${c.medianX == null ? '—' : c.medianX.toFixed(2) + 'x'}</td>
        <td class="dim" style="font-size:12px">${c.bestSymbol ? `$${h(c.bestSymbol)} ${c.bestX.toFixed(1)}x` : '—'}</td>
        <td class="r">${c.broughtVolume > 0 ? fmtNum(c.broughtVolume) : '—'}</td>
        <td class="r gold">${c.earned > 0 ? fmtNum(c.earned) : '—'}</td></tr>`).join('')}</table></div>` : ''}

    ${R ? `<div class="panel pad" style="margin-top:18px">
      <div class="row between"><div><b>Your link</b><div class="hint">Works on any page. Whoever launches a coin after arriving through it earns you ${((S.gate?.creatorRefBps ?? 500) / 100).toFixed(0)}% of their creator cut, on every token they ever launch.</div></div>
        <div class="num gold">${fmtUsd(R.earnedUsd)}</div></div>
      <div class="reflink"><code>${h(link)}</code><button class="btn sm" data-copy="${h(link)}">copy</button></div>
      <div class="replist" style="margin-top:12px;gap:10px 28px">
        <span>Buyers brought<b>${R.broughtBuyers}</b></span>
        <span>Creators brought<b>${R.broughtCreators}</b></span>
        <span>Volume brought<b>${fmtUsd(R.volumeUsd)}</b></span>
        <span>Tokens backed<b>${R.tokensBacked}</b></span>
        <span>Epochs held through<b>${R.epochsSurvived}</b></span>
      </div>
      ${hold > 0 ? `<div class="hint" style="margin-top:10px">Earning needs <b>$${fmtNum(hold)} of $REX</b> held — checked when a referral vests and again at every payout.${S.me?.rexUsd != null ? ` You hold ${fmtUsd(S.me.rexUsd)}.` : ''}</div>` : ''}
    </div>` : `<div class="panel pad" style="margin-top:18px"><div class="row between"><div><b>Get your link</b><div class="hint">Connect a wallet to start earning on what you bring.</div></div><button class="btn cta" id="gConnect"><span>Connect wallet</span></button></div></div>`}

    <!-- Elio, 5 Oct: "a dashboard for them to see their affiliate tree", "with leaderboard to see
         who was invited more". The tree walks wallets.referred_by downward — platform-level and
         first-touch, so each wallet has one referrer and the whole thing is a forest. -->
    ${tree ? `<div class="sec" style="margin-top:22px"><h2>${icon('link')}Your affiliate tree</h2><span class="muted" style="font-size:12.5px">Everyone you brought, and everyone they brought</span></div>
    <div class="panel pad">
      ${tree.total ? `<div class="stats" style="margin:0 0 14px">
          <div class="stat"><div class="l">In your tree</div><div class="v">${fmtNum(tree.total)}</div><div class="s">${tree.levels.length} level${tree.levels.length === 1 ? '' : 's'} deep</div></div>
          <div class="stat"><div class="l">Volume they brought</div><div class="v">${fmtNum(tree.volume)}</div></div>
          <div class="stat"><div class="l">Earned through them</div><div class="v gold">${fmtNum(tree.earned)}</div></div>
        </div>
        ${tree.levels.map((lv) => `<div class="treelvl">
          <div class="treelvl-h"><span class="tdepth">Level ${lv.depth}</span><span class="dim">${lv.count} wallet${lv.count === 1 ? '' : 's'}</span></div>
          ${lv.members.map((m2) => `<div class="trow" style="--d:${Math.min(lv.depth - 1, 4)}">
              <a class="w" href="/u/${h(m2.wallet)}" data-link>${h(m2.who || short(m2.wallet))}</a>
              <span class="dim">brought by ${h(short(m2.parent))}</span>
              <span class="r">${m2.vested ? `<span class="chip sm ok">vested</span>` : `<span class="chip sm">pending</span>`}</span>
              <span class="r mono">${fmtNum(m2.volume)}</span>
            </div>`).join('')}
        </div>`).join('')}
        ${tree.truncated ? `<div class="hint" style="margin-top:10px">Showing the first ${fmtNum(tree.total)} — the tree is larger.</div>` : ''}`
      : `<div class="empty">Nobody in your tree yet. Share your link above and anyone who arrives through it appears here, along with anyone THEY bring.</div>`}
    </div>` : ''}

    <div class="sec" style="margin-top:22px"><h2>${icon('crown')}Most invites</h2><span class="muted" style="font-size:12.5px">Ranked by wallets brought to REX Chain, not by volume</span></div>
    <div class="panel">${inviters.top.length
      ? `<table class="tbl"><tr><th>#</th><th>Sharer</th><th class="r">Invited</th><th class="r">Volume</th><th class="r">Earned</th></tr>${inviters.top.map((r, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td><a class="w" href="/u/${h(r.wallet)}" data-link>${h(r.who || short(r.wallet))}</a></td>
          <td class="r"><b>${fmtNum(r.invited)}</b></td>
          <td class="r mono">${fmtNum(r.volume)}</td>
          <td class="r mono gold">${fmtNum(r.earned)}</td></tr>`).join('')}</table>`
      : '<div class="empty">Nobody has invited a wallet yet.</div>'}</div>

    <div class="sec" style="margin-top:22px"><h2>${icon('link')}Top sharers</h2><span class="muted" style="font-size:12.5px">Ranked by volume actually brought — pending referrals do not count</span></div>
    <div class="panel">${top.top.length
      ? `<table class="tbl"><tr><th>#</th><th>Sharer</th><th class="r">Brought</th><th class="r">Tokens</th><th class="r">Volume</th><th class="r">Earned</th></tr>${top.top.map((r, i) => `<tr><td class="dim">${i + 1}</td><td>${walletLink(r.wallet, r.who)}</td><td class="r">${r.brought}</td><td class="r">${r.tokens || 1}</td><td class="r">${fmtNum(r.volume)}</td><td class="r gold">${r.earned > 0 ? fmtNum(r.earned) : '—'}</td></tr>`).join('')}</table>`
      : '<div class="empty">Nobody has brought a buyer yet. Be first — your link is above.</div>'}</div>

    <div class="sec" style="margin-top:22px"><h2>${icon('flag')}What just happened</h2><span class="muted" style="font-size:12.5px">Milestones across the ecosystem</span></div>
    <div class="panel">${ms.milestones.length
      ? `<table class="tbl">${ms.milestones.map((m) => `<tr><td class="dim" style="width:72px">${ago(m.ts)}</td><td><a href="/t/${m.mint}" data-link><b>$${h(m.symbol)}</b></a></td><td><span class="mark">${h(m.label)}</span></td><td class="muted" style="font-size:12px">${h(m.cast || '')}</td></tr>`).join('')}</table>`
      : '<div class="empty">No milestones yet.</div>'}</div>

    <!-- Elio's fomo referral, in his own words. It is an OUTBOUND link to a third party, so it is
         marked as one and carries rel="noopener" — and it is kept beside creator rewards because
         that is the pitch it belongs to, not dropped into unrelated chrome. -->
    <a class="fomopromo" href="https://fomo.family/r/ElioWIF" target="_blank" rel="noopener">
      <div><b>Post a thesis on Rex and get creator rewards.</b>
        <span>Trade with Elio on fomo and get 10% off fees.</span></div>
      <i>fomo.family &#8599;</i>
    </a>

    <div class="sec" style="margin-top:22px"><h2>How sharing is kept honest</h2></div>
    <div class="panel pad"><ul class="hint" style="margin:0 0 0 16px;padding:0;line-height:1.8">
      <li>A referral is <b>pending</b> until the person you brought has traded ${fmtUsd(S.gate?.refVestVolumeUsd || 50)} and is <b>still holding</b> later. Until then it counts nowhere.</li>
      <li>First touch wins and is permanent — the reward is for finding someone new, not for re-tagging a buyer somebody else brought.</li>
      <li>Referring a wallet you funded is refused, and so is anyone funded by the same source.</li>
      <li>There is a daily cap per sharer, so a farm of fresh wallets cannot scale.</li>
      ${hold > 0 ? `<li>Earning needs $${fmtNum(hold)} of $REX held, checked continuously — qualifying once and selling does not keep paying.</li>` : ''}
    </ul></div>
  </div>`;
  const c = $('#gConnect', root); if (c) c.onclick = () => connectWallet();
  return () => {};
}

// ============================================================ LEADERBOARD
// Six boards: REX pairs and farming points (Elio asked for both), plus rewards, earners, longest
// holds and creators.
//
// The boards move while you watch them, and that is the point. What makes a leaderboard worth
// coming back to is seeing that YOU moved — so every row carries its change in rank since you last
// looked, your own row is pulled out and highlighted wherever it sits, and a change at the top is
// announced. All of that is real information about real positions.
//
// What is deliberately NOT here: invented urgency. No countdown you cannot act on, no "12 people
// are buying", no manufactured near-miss. People are risking real money on this site, and a board
// that manufactures a feeling in order to provoke a trade is the one kind of engagement that costs
// the person on the other side of it. Everything below is true or it is not shown.
const LB_SNAP = 'rex_lb_ranks';
const lbSnap = () => { try { return JSON.parse(localStorage.getItem(LB_SNAP) || '{}'); } catch { return {}; } };
const lbSave = (o) => { try { localStorage.setItem(LB_SNAP, JSON.stringify(o)); } catch { /* private mode */ } };

/** ▲3 / ▼2 / — against the ranks held when this browser last looked. */
function moveChip(prev, key, id, rank) {
  const was = prev?.[key]?.[id];
  if (!Number.isFinite(was)) return '<span class="mv new" title="New on this board">NEW</span>';
  const d = was - rank;
  if (d === 0) return '<span class="mv flat">–</span>';
  return `<span class="mv ${d > 0 ? 'up' : 'down'}" title="Was #${was} when you last looked">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
}

export async function leaderboard(root) {
  let timer = null, prev = lbSnap(), firstPaint = true, prevMyRank = null;

  const load = async () => {
    const [lb, pairs, pts] = await Promise.all([
      api('/api/leaderboard').catch(() => ({ coins: [], topEarners: [], diamond: [], creators: [] })),
      api('/api/pairs?sort=volume&window=24h&limit=10').catch(() => ({ pairs: [], totals: {} })),
      api('/api/points?view=points&limit=10').catch(() => ({ rows: [], stats: {}, me: null })),
    ]);
    draw(lb, pairs, pts);
  };

  const draw = (lb, pairs, pts) => {
    const next = {};
    const me = S.me?.wallet || null;

    // A board renderer that handles rank, movement and "this row is you" once, so six boards cannot
    // drift apart in how they treat the reader.
    const board = ({ key, title, sub, rows, id, cells, href, mine, pin }) => {
      next[key] = {};
      const body = rows.map((r, i) => {
        const rank = i + 1;
        const rid = id(r);
        next[key][rid] = rank;
        const isMe = mine ? mine(r, me) : false;
        const crown = rank <= 3 ? `<span class="lbc c${rank}">${rank}</span>` : `<span class="dim">${rank}</span>`;
        return `<tr class="${isMe ? 'mine' : ''}" data-id="${h(String(rid))}">
          <td class="num">${crown}</td><td class="mvcell">${moveChip(prev, key, rid, rank)}</td>
          ${cells(r)}</tr>`;
      }).join('');
      // Your own row, pinned below the ten when you are not in them. A board you cannot find
      // yourself on is a list of strangers — and the honest way to fix that is to show where you
      // actually stand, not to flatter the number.
      const pinned = pin && !rows.some((r) => (mine ? mine(r, me) : false)) ? pin : '';
      return `<div class="panel lbpanel"><div class="pad lbhead"><div><h3>${title}</h3><div class="hint">${sub}</div></div>
        ${href ? `<a class="btn sm ghost" href="${href}" data-link>See all</a>` : ''}</div>
        ${rows.length ? `<div class="lbscroll"><table class="tbl lbtable">${body}${pinned}</table></div>` : '<div class="empty" style="margin:12px">Nothing yet</div>'}</div>`;
    };

    const usdOfPair = (t) => fmtUsd(t.volWinUsd || 0);
    const html = `<div class="fade"><div class="sec" style="margin-top:4px"><div>
        <h1 style="font-size:34px">Leaderboard</h1>
        <p class="muted" style="margin-top:6px">Everything here moves. Rank changes are measured against where things stood when you last opened this page.</p>
      </div></div>
      ${!me || !pts.me ? '' : pts.me.rank
        ? `<div class="youare"><span class="l">You</span><b>#${pts.me.rank}</b>
            <span class="dim">of ${fmtNum(pts.me.of)} on farming points</span>
            <span class="pts">${fmtNum(pts.me.points)} pts</span>
            ${pts.me.chase ? `<span class="chase">${fmtNum(pts.me.chase.gap)} pts to #${pts.me.chase.rank}</span>` : '<span class="chase top">top of the board</span>'}</div>`
        : `<div class="youare"><span class="l">You</span><b>${fmtNum(pts.me.points)}</b>
            <span class="dim">points so far</span>
            <span class="chase">hold or trade once to take a place on the board</span></div>`}
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))">
      ${board({
        key: 'pairs', title: 'REX pairs', sub: 'Every coin paired against $REX, by 24h volume', href: '/pairs',
        rows: pairs.pairs || [], id: (t) => t.mint,
        cells: (t) => `<td><a class="row" href="/t/${t.mint}" data-link>${av(t, 'sm')}<span><b>${h(t.name || t.symbol)}</b> <span class="muted">${h(t.symbol)}/${h(t.quote)}</span></span></a></td>
          <td class="r">${usdOfPair(t)}</td><td class="r ${t.chgWin > 0 ? 'up' : t.chgWin < 0 ? 'down' : 'dim'}">${pct(t.chgWin)}</td>`,
      })}
      ${board({
        key: 'points', title: 'Farming points', sub: 'Points earned by holding and trading', href: '/points',
        rows: pts.rows || [], id: (r) => r.wallet, mine: (r, w) => r.wallet === w,
        cells: (r) => `<td>${walletLink(r.wallet, r.name)}</td>
          <td class="r gold">${fmtNum(r.points)}<small> pts</small></td>
          <td class="r dim lbmin">${(r.badges || []).slice(0, 1).join('') || `${r.days || 0}d`}</td>`,
        pin: me && pts.me?.rank ? `<tr class="mine pinned"><td class="num"><span class="dim">${pts.me.rank}</span></td>
          <td class="mvcell"><span class="mv flat">you</span></td>
          <td>${walletLink(me, S.me?.name)}</td>
          <td class="r gold">${fmtNum(pts.me.points)}<small> pts</small></td>
          <td class="r dim lbmin">${(pts.me.badges || []).slice(0, 1).join('') || ''}</td></tr>` : '',
      })}
      ${board({
        key: 'coins', title: 'Most rewards to holders', sub: 'Holder rewards distributed, in USD',
        rows: lb.coins || [], id: (t) => t.mint,
        cells: (t) => `<td><a class="row" href="/t/${t.mint}" data-link>${av(t, 'sm')}<span><b>${h(t.name)}</b> <span class="muted">$${h(t.symbol)}</span></span></a></td>
          <td class="r gold">${fmtUsd(t.yieldPaid * t.quoteUsd)}</td><td class="r dim lbmin">${t.yieldPayouts} payouts</td>`,
      })}
      ${board({
        key: 'earners', title: 'Top earners', sub: 'Wallets paid the most yield',
        rows: lb.topEarners || [], id: (x) => x.wallet, mine: (x, w) => x.wallet === w,
        cells: (x) => `<td>${walletLink(x.wallet, x.who)}</td><td class="r gold">${fmtUsd(x.usd)}</td><td class="r dim lbmin">${x.n} payouts</td>`,
      })}
      ${board({
        key: 'diamond', title: 'Longest holds', sub: 'Unbroken positions right now — a badge, not a multiplier',
        rows: lb.diamond || [], id: (x) => x.wallet + x.mint, mine: (x, w) => x.wallet === w,
        cells: (x) => `<td>${walletLink(x.wallet, x.who)}</td><td class="lbmin"><a href="/t/${x.mint}" data-link><b>$${h(x.symbol)}</b></a></td><td class="r dim">${ago(x.heldSince)}</td>`,
      })}
      ${board({
        key: 'creators', title: 'Top creators', sub: 'Launches and graduations',
        rows: lb.creators || [], id: (x) => x.creator, mine: (x, w) => x.creator === w,
        cells: (x) => `<td>${walletLink(x.creator, x.who)}</td><td class="r lbmin">${x.n} launches</td><td class="r gold">${x.g || 0} graduated</td>`,
      })}
      </div></div>`;

    root.innerHTML = html;

    // A change at the top is the one event on a board worth interrupting for — and only when it is
    // a CHANGE, never on first paint, or every visit would open with a celebration of nothing.
    if (!firstPaint) {
      for (const [key, label] of [['pairs', 'REX pairs'], ['points', 'farming points']]) {
        const before = Object.entries(prev[key] || {}).find(([, r]) => r === 1)?.[0];
        const nowTop = Object.entries(next[key] || {}).find(([, r]) => r === 1)?.[0];
        if (before && nowTop && before !== nowTop) {
          const row = root.querySelector(`[data-id="${CSS.escape(nowTop)}"]`);
          row?.classList.add('tookover');
          toast('gold', `New #1 on ${label}`);
        }
      }
    }
    // Rows that moved get a one-shot flash, so the change is visible without reading the chip.
    root.querySelectorAll('.mv.up, .mv.down').forEach((m) => m.closest('tr')?.classList.add('moved'));

    // YOUR movement is the only one worth a celebration — the board moving is information, you
    // moving is an event. Climbing bursts from your own row; slipping does not, because kicking
    // somebody while they are going down is not a delight, it is a taunt.
    if (!firstPaint && me && pts.me?.rank) {
      const was = prevMyRank;
      if (Number.isFinite(was) && pts.me.rank < was) {
        const row = root.querySelector('tr.mine');
        if (pts.me.rank === 1) { celebrate(['#ffc24d', '#3dffa0', '#9dff8f']); toast('gold', 'You are #1 on farming points'); }
        else if (row) burst(row, { count: 18, power: 8 });
      }
      if (Number.isFinite(was) && was !== pts.me.rank) flash(root.querySelector('.youare'));
    }
    prevMyRank = pts.me?.rank ?? null;

    // Live figures roll rather than snap, so a board that refreshes under you reads as alive
    // instead of as a page that blinked.
    root.querySelectorAll('.ptile b, .youare b').forEach((b) => { b.dataset.v = b.dataset.v ?? b.textContent; });

    prev = next;
    lbSave(next);
    firstPaint = false;
  };

  root.innerHTML = '<div class="fade"><div class="empty" style="margin-top:60px">Loading the boards…</div></div>';
  await load();
  // Same reasoning as the pairs board: the poll is a floor, a real trade refreshes it at once.
  let liveT = null;
  const live = () => { clearTimeout(liveT); liveT = setTimeout(() => { if (!document.hidden) load(); }, 1200); };
  const offs = [bus.on('trade', live), bus.on('token', live), bus.on('graduated', live)];
  timer = setInterval(() => { if (!document.hidden) load(); }, 20_000);
  return () => { clearInterval(timer); clearTimeout(liveT); offs.forEach((f) => f()); };
}

// ============================================================ LEARN
/**
 * The brand page — logo, glyph, colour, type, and the rules for using them.
 *
 * ⛔ PHILL ASKED "do you have rex design page?" AND THE ANSWER WAS NO. The assets existed in
 * public/brand — glyph, avatar, hero, the Inter files — and there was no route to any of them, so
 * anyone writing about REX Chain either asked in Telegram or guessed. Guessing is how a project
 * ends up with six versions of its own mark in circulation.
 *
 * Every colour below is read from the stylesheet's own custom properties at render time rather
 * than typed in here, so this page cannot drift from the product the way a hand-maintained brand
 * sheet always does.
 */
export async function brand(root) {
  const read = (v, fallback) => {
    try {
      const got = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      return got || fallback;
    } catch { return fallback; }
  };
  const swatch = (v, name, note) => {
    const val = read(v, '');
    return `<div class="bswatch">
      <span class="bchip" style="background:${h(val)}"></span>
      <span class="bmeta"><b>${h(name)}</b><code>${h(v)}</code><code class="dim">${h(val)}</code>
      <small class="dim">${h(note)}</small></span>
    </div>`;
  };
  const asset = (src, label, note) => `<div class="basset">
    <span class="bart" style="background-image:url('${h(src)}')"></span>
    <span class="bmeta"><b>${h(label)}</b><code>${h(src)}</code><small class="dim">${h(note)}</small>
      <a class="gold" href="${h(src)}" download>download</a></span>
  </div>`;

  root.innerHTML = `<div class="fade learn">
    <div class="eyelabel">Brand</div>
    <h1 style="margin-top:10px">Use the real mark.</h1>
    <p class="muted" style="font-size:16px;margin-top:12px;max-width:660px">Everything here is the
      same file and the same colour value the site itself renders, so a post, a listing or a
      terminal integration can match it exactly. Take what you need — no permission required for
      editorial or listing use.</p>

    <div class="block"><h2>${icon('rocket')}The mark</h2>
      <div class="bgrid">
        ${asset('/brand/rex-glyph@1024.png', 'Glyph, 1024px', 'The primary mark. Use this one unless you have a reason not to.')}
        ${asset('/brand/rex-glyph.png', 'Glyph, small', 'For favicons and anywhere under 64px.')}
        ${asset('/brand/rex-avatar.png', 'Avatar', 'Square, for social profiles.')}
        ${asset('/brand/rex-hero.jpg', 'Hero', 'Wide, for headers and cards.')}
      </div>
      <div class="hint" style="margin-top:10px">Keep clear space of at least the glyph's own height around it, and never place it on a background lighter than the mint below — it is drawn for dark surfaces and loses its edge on white.</div>
    </div>

    <div class="block"><h2>${icon('flame')}Colour</h2>
      <div class="bgrid">
        ${swatch('--rex', 'REX green', 'The one brand colour. Actions, gains, the mark.')}
        ${swatch('--lime', 'Lime', 'Highlights and the gold accent role.')}
        ${swatch('--deep', 'Deep', 'Pressed states and deep fills.')}
        ${swatch('--mint', 'Mint', 'The lightest surface a mark may sit on.')}
        ${swatch('--bg', 'Background', 'The page itself.')}
        ${swatch('--panel', 'Panel', 'Cards and panels.')}
        ${swatch('--down', 'Down', 'Losses only — never decoration.')}
      </div>
    </div>

    <div class="block"><h2>${icon('scales')}Type</h2>
      <p class="muted">Inter, shipped with the site: <code>/brand/fonts/Inter-Regular.ttf</code> and
        <code>/brand/fonts/Inter-Bold.ttf</code>, under the SIL Open Font License
        (<a class="gold" href="/brand/fonts/LICENSE-Inter.txt">licence</a>). Figures are set with
        tabular numerals so columns line up; if you are rebuilding a table, do the same.</p>
    </div>

    <div class="block"><h2>${icon('gem')}What not to do</h2>
      <ul class="muted" style="line-height:1.9">
        <li>Don't recolour the glyph. If it needs to be one colour, use white or REX green.</li>
        <li>Don't redraw or re-generate it — these files are the mark, not a reference for one.</li>
        <li>Don't stretch it. Scale both axes together.</li>
        <li>Don't imply a partnership or an endorsement that does not exist.</li>
      </ul>
    </div>
  </div>`;
}

export async function learn(root) {
  const g = S.gate || {};
  root.innerHTML = `<div class="fade learn">
    <div class="eyelabel">How REX Chain works</div>
    <h1 style="margin-top:10px">Proof, not promises.</h1>
    <p class="muted" style="font-size:16px;margin-top:12px;max-width:660px">The wedge is the <b>open</b>, not the fee. A pair clears at one price, holders are paid in the quote asset, the dev can take 1% and share it with whoever brings volume, and the vault is liquidity. The ceiling is 5%.</p>
    <div class="block"><h2>${icon('scales')}1. Fair Open — nobody gets the first bite</h2>
      <p>On every other launchpad the first block belongs to bots. They see the create transaction, land in the same slot and buy the bottom of the curve before a human can click. The creator's own "dev buy" is a second, quieter version of the same edge. REX Chain removes both.</p>
      <div class="diagram"><div class="box"><b>Window opens</b>60 s by default, up to 5 min. Commitments are escrowed — anyone can commit or withdraw until the bell.</div><div class="arrow">→</div><div class="box"><b>The bell</b>All commitments clear as <em>one</em> buy on the curve. Everyone — dev included — gets the same average price, allocated pro-rata.</div></div>
      <ul><li>No ordering advantage exists inside the window, so there is nothing for a sniper to snipe.</li><li>The dev buy is just another commitment. The creator provably cannot front-run their own launch.</li><li>You see the committed total and the estimated opening market cap live, before you commit.</li>
      <li>30 seconds is too short, so it is not an option. Instant stays for degens and is not recommended.</li>
      <li>An allowlist, if the creator sets one, only exists <b>inside</b> the window. After the clear the pool is public — an allowlist with no window is a private snipe and does not ship here.</li>
      <li>We make no claim that a bundle cannot exist. The claim is that it cannot buy a different price.</li></ul></div>
    <div class="block"><h2>${icon('rex')}2. The fee is a payout, a vault and a burn</h2>
      <p>Reward-mode launchpads take 1% or 3% <b>in the token</b> on every move — a send included — and then sell it into the pool to pay you. The coin funds its own payout. REX Chain charges in the <b>quote asset</b>, on the <b>swap only</b>. A send pays nothing, and the fee is never taken in the launched token.</p>
      <p style="margin-top:10px">The creator sets each bucket themselves, in half-point steps. There is no menu. The only rule is the sum: four fields, 4% ceiling, and the contract rejects anything above it or above a field's own ceiling.</p>
      <table class="cmp"><tr><th>Bucket</th><th>Range</th><th>What it does</th></tr>
        <tr><td>Holder rewards</td><td class="mono">1 – 3%</td><td>Quote asset, swaps only. Split at the epoch snapshot by the launcher's chosen rule — <b>${icon('gem')}Diamond Hands</b> (balance × a 1.0x–3.0x multiplier by hours held, the default) or <b>Simple</b> (balance alone).</td></tr>
        <tr><td>Creator</td><td class="mono">0 – 1%</td><td>Quote asset, paid each epoch. REX does not touch it.</td></tr>
        <tr><td>Vault</td><td class="mono">0 – 1%</td><td>70% concentrated LP, 30% quote bid. Liquidity, not a wallet. No redeem.</td></tr>
        <tr><td>Burn</td><td class="mono">0 – 1%</td><td>Quote buys the launched token and burns it.</td></tr>
        <tr><td>Cap</td><td class="mono gold">4%</td><td>Sum of the four, shown before the launch transaction is signed.</td></tr></table>
      <div class="panel pad" style="margin-top:14px">
        <h3>${icon('gem')}Diamond Hands, and the alternative</h3>
        <p style="margin-top:6px">The holder bucket decides <i>how much</i> goes to holders. How it is <i>divided between them</i> is a separate choice the launcher makes once, at launch, and cannot change afterwards — because it is the rule people buy into.</p>
        <table class="cmp" style="margin-top:10px"><tr><th>Mode</th><th>Weight</th><th>What it means</th></tr>
          <tr><td><b>${icon('gem')}Diamond Hands</b><br><span class="dim">default</span></td><td class="mono">balance × 1.0–3.0x</td><td>The multiplier climbs with hours held and reaches <b>3.0x</b> at three days. A three-day holder earns <b>three times</b> what a wallet of the same size that bought a minute ago earns. <b>Any sell resets the clock to zero.</b></td></tr>
          <tr><td><b>${icon('scales')}Simple</b></td><td class="mono">balance</td><td>Strictly proportional to how much you hold. Predictable — but a whale who bought a minute ago out-earns someone who has held a month with half the size.</td></tr></table>
        <p style="margin-top:10px">Two things hold in <b>both</b> modes: the <b>$20 eligibility floor</b> is measured on balance alone, so hold time can raise your share but never your eligibility; and a wallet we have no hold record for is paid at <b>1.0x</b> rather than skipped.</p>
      </div>
      <p style="margin-top:12px">So <b>1/1/1</b> is a legal 3%. <b>2/1/1</b> and <b>3 / 0.5 / 0.5</b> are legal 4%s. <b>3/1/1</b> is 5% and reverts, and 2% rewards with a 1.5% vault reverts too — the vault ceiling is 1% whatever the sum says.</p>
      <ul><li>Your share of an epoch is your balance ÷ the eligible total. Hold time is a badge here, not a multiplier.</li>
      <li>The floor is the quote-asset equivalent of <b>$20</b>. Pool, vault, burner and team-lock wallets are excluded.</li>
      <li>The first epoch is short and published. It closes and pays what was collected — a zero page is a bug, not a design.</li>
      <li>After graduation the same split keeps running on the AMM. The LP is burned, so nobody is collecting a pool fee behind it.</li>
      <li><b>There is no platform fee on top.</b> The sum you set is the whole take — REX Chain is paid out of the rewards bucket and nowhere else.</li></ul></div>
    <div class="block"><h2>Where REX's own cut comes from</h2>
      <p>REX is paid <b>out of the holder-rewards bucket only</b> — it is not a fifth fee. Holders keep 80% of that bucket until $2M of verified volume, 85% to $10M, and 90% after. The tiers only move one way. Verified volume is quote-asset notional, net of same-signer and common-funder wash.</p>
      <table class="cmp"><tr><th>Verified volume</th><th>Holders keep</th><th>REX takes</th></tr><tr><td>Launch → $2M</td><td class="mono">80%</td><td class="mono">20%</td></tr><tr><td>$2M → $10M</td><td class="mono">85%</td><td class="mono">15%</td></tr><tr><td>$10M +</td><td class="mono gold">90%</td><td class="mono">10%</td></tr></table>
      <p style="margin-top:12px">Of REX's own slice: 20% buys $REX and burns it in the same transaction, 60% is a permissionless buyback with an epoch cap and no admin timing key, and 20% joins the same vault LP engine as the pair. <b>Burn, vault and the creator's cut never pass through REX.</b></p>
      <p style="margin-top:10px">On a 3 / 0.5 / 0.5 mix at $1M of daily volume: holders $24,000, vault $5,000, burn $5,000, REX $6,000 out of the rewards bucket. On 1/1/1: holders $8,000, vault $10,000, burn $10,000, REX $2,000.</p></div>
    <div class="block"><h2>The vault</h2>
      <p>The vault leg arrives as quote and is deposited as <b>liquidity</b>. It does not pull from the pair's pool. 70% becomes a concentrated LP position; 30% stays quote and bids inside a published band. Fees compound into the same position, and the address is public from the first deposit.</p>
      <ul><li>No share token. No public deposit. No redeem.</li><li>On a stock pair the LP is USDG/STOCK — and only after that route is live. On a REX pair it is REX/quote; a USDC reserve is not labelled a stock position.</li><li>One stock name per sprint, starting with NVDA, and a second only after the first has compounded without a manual rebalance.</li></ul></div>
    <div class="block"><h2>Against the field</h2>
      <table class="vs"><tr><th></th><th>Pump</th><th>Stonk</th><th class="rex">REX Chain</th></tr>
        <tr><td>Open</td><td>Slot auction. Block zero wins.</td><td>No sealed clear.</td><td class="rex">60 s, one price.</td></tr>
        <tr><td>Holders</td><td>Nothing.</td><td>1–3%, taken in the token and sold into the pool.</td><td class="rex">1–3%, quote asset. Sends free.</td></tr>
        <tr><td>Creator</td><td>About 0.30%.</td><td>About 0.50%, or zero on a reward coin.</td><td class="rex">0–1%, untouched by REX.</td></tr>
        <tr><td>Vault</td><td>Burned LP.</td><td>None.</td><td class="rex">0–1%, 70/30 LP, public address.</td></tr>
        <tr><td>Cap</td><td>1.25% flat.</td><td>Tax plus swap fee.</td><td class="rex">4%, sum checked on chain.</td></tr>
        <tr><td>Day one</td><td>Live.</td><td>Live.</td><td class="rex">The epoch pays from the first session.</td></tr></table>
      <p class="muted" style="margin-top:12px;font-size:12.5px">We lose a pure fee comparison with Pump, and we are not running that race. What we win is the dev who already launched a REX pair on Stonk and wants the payout without the sell — plus a vault.</p></div>
    <div class="block"><h2>$REX is the native quote</h2>
      <p>Coins here are priced in <b>$REX</b> (<span class="mono">${g.rexMint ? g.rexMint.slice(0, 6) + '…' + g.rexMint.slice(-4) : ''}</span>), not SOL. Every buy on a REX-quoted curve has to buy $REX first, every raise is held in $REX, and every holder payout is paid in $REX. SOL, USDC and $GP are available too, but REX is the default for a reason: the launchpad's volume is REX demand.</p>
      <p style="margin-top:10px"><b>Anyone can launch.</b> There is no hold requirement and no gate. Holding <b>$REX</b> buys a better rate instead: a qualifying launch opens further down the REX fee schedule, and because that fee is carved out of the holder allocation, every step it drops goes to <b>that token's holders</b> rather than into the creator's pocket.</p></div>
    <div class="block"><h2>The curve</h2><p>Constant-product virtual reserves sized like Raydium LaunchLab / pump: 793.1M of the 1B supply sells on the curve, the raise is "worth 85 SOL" in whatever quote you pick, and at the target the raise plus the reserved 206.9M migrate to an AMM at precisely the curve's final price — no gap, no dump window. No launch fee, and no platform fee on top of the split.</p>
      <table class="cmp"><tr><th>Feature</th><th>Typical launchpad</th><th>REX Chain</th></tr><tr><td>Holder rewards</td><td class="n">In the token, sold into the pool</td><td class="y">Quote asset, swaps only, on a countdown</td></tr><tr><td>Sniper-proof opening</td><td class="n">No</td><td class="y">Fair Open</td></tr><tr><td>Dev buy at the same price as everyone</td><td class="n">No</td><td class="y">Yes</td></tr><tr><td>Fee on a plain send</td><td class="n">Charged</td><td class="y">Zero</td></tr><tr><td>Next payout visible</td><td class="n">No</td><td class="y">Live countdown</td></tr><tr><td>Fee on top of the advertised one</td><td class="n">Swap fee as well as the tax</td><td class="y">None — the sum is the take</td></tr><tr><td>Fee ceiling</td><td class="n">Tax + swap fee, uncapped</td><td class="y">4%, checked on chain</td></tr></table></div>
    <div class="block"><h2>Status of this build</h2><p>Everything here runs on the REX Chain engine with real wallet sign-in (Phantom signature). The demo market is seeded with real coins and artwork pulled from public launchpad data and re-quoted in $REX to show the flywheel; balances are a paper ledger with a faucet so you can exercise every mechanic end to end. The on-chain settlement program is the next milestone and swaps in behind the same API.</p>
      <div class="row wrap" style="margin-top:14px"><a class="btn" href="https://rex.fun" target="_blank" rel="noopener">rex.fun</a><a class="btn" href="https://x.com/tryrexfun" target="_blank" rel="noopener">𝕏 @tryrexfun</a><a class="btn" href="https://t.me/tryrexfun" target="_blank" rel="noopener">Telegram</a><a class="btn" href="https://dexscreener.com/solana/8xzxttcfq49n5awdmtlaok7mkmz65aaatpqryd9m1jl7" target="_blank" rel="noopener">$REX chart</a></div></div>
  </div>`;
  return () => {};
}

// ============================================================ REWARDS (bridged from rewards.rex.fun)
export async function rewards(root) {
  root.innerHTML = '<div class="fade"><div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:260px"></div></div>';
  let d; try { d = await api('/api/rewards'); } catch (e) { root.innerHTML = `<div class="empty">Rewards service unreachable — ${h(niceErr(e))}</div>`; return () => {}; }
  const a = d.analytics || {}, t = d.totals, cfgb = d.config || {};
  const rexUsd = a.priceUsd || usdOf('REX');
  const BT = { holders: 'Community airdrop', buyRex: 'Buyback', burnRex: 'Burn', transfer: 'Vault' };
  const bucketCard = (b) => `<div class="bkt"><div class="pct">${Math.round(b.pct * 100)}%</div><div class="bl">${h(b.label || BT[b.type] || b.key)}</div><div class="bt">${h(BT[b.type] || b.type)}</div></div>`;
  const round = (r) => { const com = (r.buckets || []).find((x) => x.type === 'holders') || {}; return `<tr><td class="dim">#${r.round}</td><td>${new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td><td><span class="chip ${r.kind === 'REX' ? 'conv' : ''}">${h(r.kind || '—')}</span></td><td class="r">${fmtNum(r.pot)} ${h(r.kind === 'REX' ? 'REX' : 'SOL')}</td><td class="r">${fmtUsd(r.potUsd)}</td><td class="r">${r.eligible ?? '—'}</td><td class="r gold">${com.paidUsd != null ? fmtUsd(com.paidUsd) : (com.amount != null ? fmtNum(com.amount) : '—')}</td></tr>`; };
  root.innerHTML = `<div class="fade">
    <div class="eyelabel">$REX holder rewards</div>
    <div class="sec" style="margin-top:8px;align-items:flex-start"><div><h1 style="font-size:34px">Every fee comes back.</h1>
      <p class="muted" style="margin-top:8px;max-width:620px">The $REX rewards program takes trading fees and splits them across the community, buybacks, burns and the vault — on-chain, every round. This is the live ledger, mirrored from <a class="gold" href="${h(d.base)}" target="_blank" rel="noopener">rewards.rex.fun</a>.</p></div>
      <a class="btn" href="${h(d.base)}" target="_blank" rel="noopener">Open full ledger ↗</a></div>
    <div class="stats">
      <div class="stat"><div class="l">Holder rewards</div><div class="v gold">${fmtUsd(t.paidUsd)}</div><div class="s">${t.rounds} rounds · ${fmtNum(t.walletsRewarded)} wallet payouts</div></div>
      <div class="stat"><div class="l">Burned by the program</div><div class="v">${fmtNum(t.burnedByProgram)} REX</div><div class="s">${fmtUsd(t.burnedByProgram * rexUsd)}${t.burnedTotal > t.burnedByProgram * 1.01 ? ` · ${fmtNum(t.burnedTotal)} burned all-time` : ''}</div></div>
      <div class="stat"><div class="l">Holders</div><div class="v">${fmtNum(t.holders)}</div><div class="s">${fmtNum(t.eligible)} above the floor</div></div>
      <div class="stat"><div class="l">Reward floor</div><div class="v">${fmtUsd(cfgb.minHoldUsd || 20)}</div><div class="s">${fmtNum(t.minHoldRex)} REX at today's price</div></div>
    </div>
    ${burnPanel()}
    <div class="panel pad" id="myrw" style="margin-top:12px"></div>
    <div class="sec"><h2>Where every round goes</h2><span class="muted">${h(cfgb.basketMode === 'rotate' ? 'basket rotates one asset per round' : 'fixed split')}</span></div>
    <div class="bkts">${(cfgb.buckets || []).map(bucketCard).join('') || '<div class="empty">Split unavailable</div>'}</div>
    <div class="sec"><h2>$REX market</h2><a class="muted" href="https://dexscreener.com/solana/8xzxttcfq49n5awdmtlaok7mkmz65aaatpqryd9m1jl7" target="_blank" rel="noopener">chart ↗</a></div>
    <div class="kpis" style="grid-template-columns:repeat(6,1fr)">
      <div class="k"><div class="l">Price</div><div class="v">${a.priceUsd ? '$' + a.priceUsd.toPrecision(3) : '—'}</div></div>
      <div class="k"><div class="l">24h</div><div class="v ${(a.change?.h24 || 0) >= 0 ? 'up' : 'down'}">${a.change ? pct(a.change.h24 / 100) : '—'}</div></div>
      <div class="k"><div class="l">Market cap</div><div class="v">${fmtUsd(a.marketCap)}</div></div>
      <div class="k"><div class="l">Liquidity</div><div class="v">${fmtUsd(a.liquidityUsd)}</div></div>
      <div class="k"><div class="l">24h volume</div><div class="v">${fmtUsd(a.volume?.h24)}</div></div>
      <div class="k"><div class="l">Top 10 hold</div><div class="v">${a.top10Pct ? a.top10Pct.toFixed(1) + '%' : '—'}</div></div>
    </div>
    <div class="sec"><h2>Rounds</h2><span class="muted">newest first</span></div>
    <div class="panel">${d.rounds.length ? `<table class="tbl"><tr><th>#</th><th>When</th><th>Paid in</th><th class="r">Pot</th><th class="r">Value</th><th class="r">Eligible</th><th class="r">To community</th></tr>${d.rounds.map(round).join('')}</table>` : '<div class="empty">No rounds yet</div>'}</div>
    <div class="hint" style="margin-top:14px">Rewards are paid by the $REX program, not by REX Chain. Holding $REX also unlocks launching here — same balance, two uses.</div>
  </div>`;
  /**
   * Buyback and burn.
   *
   * These numbers were already being fetched and then thrown away, which is why the panel read as
   * "no burn yet" while 92k REX had in fact been burned. Everything here is a figure the rewards
   * program publishes, and the last burn links to its own transaction — a burn you cannot click
   * through to is a claim, not a receipt.
   */
  function burnPanel() {
    const b = d.burn;
    if (!b) return `<div class="sec"><h2>Buyback and burn</h2></div>
      <div class="panel pad"><span class="muted">The rewards program is not answering right now. Nothing has been lost — this panel reads its ledger, it does not keep its own.</span></div>`;
    const burned = Number(b.burnedByBuybacks) || 0, bought = Number(b.boughtBack) || 0;
    const pot = Number(b.potUsd) || 0, target = Number(b.potTargetUsd) || 0;
    const pct = target > 0 ? Math.min(100, (pot / target) * 100) : 0;
    const over = target > 0 && pot >= target;
    const last = b.lastBurn;
    return `<div class="sec"><h2>${icon('flame')}Buyback and burn</h2>
        <span class="muted">${b.burnSharePct ?? 0}% burned · ${b.buybackSharePct ?? 0}% bought and held</span></div>
      <div class="panel pad">
        <div class="stats" style="margin:0">
          <div class="stat"><div class="l">Burned by the program</div><div class="v gold ticker" data-to="${burned}" data-suffix=" REX">0 REX</div>
            <div class="s">${fmtUsd(burned * rexUsd)} · gone for good</div></div>
          <div class="stat"><div class="l">Bought back and held</div><div class="v">${fmtNum(bought)} REX</div>
            <div class="s">${fmtUsd(bought * rexUsd)} · off the market</div></div>
          <div class="stat"><div class="l">Last burn</div>
            <div class="v">${last?.rex ? fmtNum(last.rex) + ' REX' : '—'}</div>
            <div class="s">${last?.at ? ago(last.at) + ' ago' : 'none yet'}${last?.sig ? ` · <a class="gold" href="https://solscan.io/tx/${h(last.sig)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</div></div>
        </div>
        ${target > 0 ? `<div style="margin-top:14px">
          <div class="prog burnbar"><i style="width:${Math.max(pct, 1.5).toFixed(1)}%"></i></div>
          <div class="prog-l"><span>${fmtUsd(pot)} in the pot</span><span>${over ? (b.autoOn ? 'burning on the next run' : 'waiting on a manual run') : `fires at ${fmtUsd(target)}`}</span></div>
          <!-- ⛔ THE OLD HINT HERE WAS FALSE, NOT MERELY VAGUE: "fees collect until the pot reaches
               the threshold, then one buy goes through". The pot reached the threshold and no buy
               went through — it sat at 2.8x for eighteen days — so the one line on the site that
               set the reader's expectation was also the line guaranteeing the behaviour that was
               not happening. Describing a trigger as automatic when a human has to press it is how
               a working ledger came to look like a broken one. -->
          <div class="hint" style="margin-top:6px">${over
            ? (b.autoOn
              ? `The pot is past its ${fmtUsd(target)} threshold, so the next scheduled run buys and burns from it. A pot at zero means the last one just fired, not that nothing is happening.`
              : `The pot is past its ${fmtUsd(target)} threshold and is waiting to be run${b.lastRoundAt ? `, the last round having been ${ago(b.lastRoundAt)} ago` : ''}. The threshold is not what is holding it: rounds are started by hand, so the pot keeps filling until one is.`)
            : 'Fees collect until the pot reaches the threshold, then a round buys and burns from it. A pot at zero means the last one just fired, not that nothing is happening.'}</div>
        </div>` : ''}
        ${(d.burns || []).length ? `<div class="burnlist">
          ${d.burns.map((x) => `<div class="brow">
            <span class="bx">${icon('flame')}</span>
            <span class="bamt">Burned ${fmtNum(x.rex)} REX</span>
            <span class="bwhen">${ago(x.at)} ago</span>
            ${x.sig ? `<a class="btx" href="https://solscan.io/tx/${h(x.sig)}" target="_blank" rel="noopener">tx ↗</a>` : '<span class="btx dim">—</span>'}
          </div>`).join('')}
        </div>` : ''}
      </div>`;
  }

  tickUp(root);

  async function mine() {
    const box = $('#myrw', root); if (!box) return;
    if (!S.me) { box.innerHTML = `<div class="row between wrap"><div><h3>Your rewards</h3><div class="hint" style="margin-top:4px">Connect a wallet to see your $REX position, whether you clear the floor, and what you've been paid.</div></div><button class="btn cta" id="cw"><span>Connect wallet</span></button></div>`; const c = $('#cw', box); if (c) c.onclick = connectWallet; return; }
    box.innerHTML = '<div class="hint">Checking your wallet on-chain…</div>';
    try {
      const m = await api('/api/rewards/holder?w=' + S.me.wallet);
      const q = m.qualifies ?? (m.valueUsd >= (cfgb.minHoldUsd || 20));
      box.innerHTML = `<div class="row between wrap" style="gap:16px"><div><h3>Your rewards</h3><div class="row wrap" style="margin-top:8px;gap:18px">
        <div><div class="l dim" style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase">REX held</div><div class="num" style="font-size:18px">${fmtNum(m.rex ?? m.balance ?? 0)}</div><div class="hint">${fmtUsd(m.valueUsd ?? 0)}</div></div>
        <div><div class="l dim" style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase">Floor</div><div class="num" style="font-size:18px">${q ? '<span class="up">clears</span>' : '<span class="down">below</span>'}</div><div class="hint">${fmtUsd(cfgb.minHoldUsd || 20)} minimum</div></div>
        <div><div class="l dim" style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase">Received</div><div class="num gold" style="font-size:18px">${fmtUsd(m.receivedUsd ?? 0)}</div><div class="hint">across ${m.rounds ?? 0} rounds</div></div>
        ${m.excluded ? '<div><div class="l dim">Status</div><div class="num down">excluded</div><div class="hint">infrastructure wallet</div></div>' : ''}
      </div></div><a class="btn" href="${h(d.base)}?w=${encodeURIComponent(S.me.wallet)}" target="_blank" rel="noopener">My payouts ↗</a></div>`;
    } catch (e) { box.innerHTML = `<div class="hint">Could not read your wallet: ${h(niceErr(e))}</div>`; }
  }
  mine();
  const off = bus.on('auth', mine);
  return () => off();
}

// ============================================================ SWAP (Jupiter)
// "integrate Jupiter in backend like dexscreener does, and charge 0.5% fee on every swap".
//
// Two things about this page are worth knowing before reading it. The quote and the transaction are
// built by OUR server, not by the browser — the fee is ours to set, and a browser that builds its own
// Jupiter URL can simply drop it. And it is mainnet, always, whatever cluster the rest of the site is
// pointed at: Jupiter has no devnet, so the page says so rather than quietly failing at signature.
export async function swap(root) {
  const cfgSwap = S.swap;
  if (!cfgSwap) {
    root.innerHTML = `<div class="fade"><div class="empty" style="margin-top:60px">Swaps are not enabled on this deployment.</div></div>`;
    return () => {};
  }
  let toks = [], from = null, to = null, amt = '', q = null, busy = false, err = '', ready = null;
  const DEFAULT_IN = 'So11111111111111111111111111111111111111112';
  const CA = S.gate?.rexCa;

  const fmtTok = (base, dec) => (Number(base || 0) / 10 ** (dec ?? 0));
  const pick = (mint) => toks.find((t) => t.mint === mint);

  const row = (side, t) => `<button class="tokpick" data-side="${side}">${t
    ? `${t.icon ? `<img src="${h(t.icon)}" alt="" loading="lazy">` : '<i class="dot"></i>'}<b>${h(t.symbol)}</b>`
    : '<b>Select</b>'}<svg width="11" height="11" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.5" d="m6 9 6 6 6-6"/></svg></button>`;

  const draw = () => {
    const fi = pick(from), ti = pick(to);
    // ⛔ ASKED BEFORE THE BUTTON IS ARMED, not translated after it fails. A wallet with zero lamports
    // is not an account, so preflight dies before any program runs and the logs come back EMPTY —
    // see jupiter.readiness for the whole diagnosis. Nothing said at failure time helps, because the
    // swap someone is attempting is usually how they meant to get the SOL in the first place.
    const noGas = !!(S.me && ready && !ready.enough);
    const outUi = q ? fmtTok(q.quote.outAmount, ti?.decimals) : 0;
    const inUsd = fi && amt ? Number(amt) * (fi.usd || 0) : 0;
    const outUsd = ti ? outUi * (ti.usd || 0) : 0;
    const impact = q ? Number(q.quote.priceImpactPct || 0) * 100 : 0;
    const feeUi = q?.quote?.platformFee ? fmtTok(q.quote.platformFee.amount, ti?.decimals) : 0;
    root.innerHTML = `<div class="fade swapwrap">
      <div class="sec" style="margin-top:4px"><div><h1 style="font-size:34px">Swap</h1>
        <p class="muted" style="margin-top:6px">Every token on Solana, routed by Jupiter. ${(() => {
          // Say what is ACTUALLY being charged, not what is configured. The fee only applies on a
          // route whose output mint REX already has a token account for, so on any other pair it is
          // genuinely zero — and a page that advertised 0.50% while charging nothing would be lying
          // in the direction that costs us trust rather than money.
          if (!cfgSwap.feeBps) return '<b class="ember">No platform fee is being taken</b> — no fee wallet is configured yet.';
          if (!q) return `REX takes up to ${(cfgSwap.feeBps / 100).toFixed(2)}% of the output.`;
          return q.feeBps
            ? `REX takes ${(q.feeBps / 100).toFixed(2)}% of the output on this route.`
            : `<b class="ember">No fee on this route</b> — REX has no token account for ${h(pick(to)?.symbol || 'this token')} yet, so nothing is taken.`;
        })()}</p></div></div>
      <div class="panel pad swapcard">
        <div class="swapleg"><div class="row between"><span class="l">You pay</span><span class="dim">${fi ? h(fi.name || '') : ''}</span></div>
          <div class="row"><input id="swAmt" inputmode="decimal" placeholder="0.0" value="${h(amt)}">${row('from', fi)}</div>
          <div class="dim" style="font-size:12px;margin-top:4px">${inUsd ? fmtUsd(inUsd) : '&nbsp;'}</div></div>
        <button class="swapflip" id="swFlip" title="Flip">⇅</button>
        <div class="swapleg"><div class="row between"><span class="l">You receive</span><span class="dim">${ti ? h(ti.name || '') : ''}</span></div>
          <div class="row"><input id="swOut" value="${outUi ? fmtNum(outUi) : ''}" placeholder="0.0" readonly>${row('to', ti)}</div>
          <div class="dim" style="font-size:12px;margin-top:4px">${outUsd ? fmtUsd(outUsd) : '&nbsp;'}</div></div>
        ${q ? `<div class="swapinfo">
          <span><span class="dim">Rate</span><b>1 ${h(fi.symbol)} ≈ ${fmtNum(outUi / Number(amt || 1))} ${h(ti.symbol)}</b></span>
          <span><span class="dim">Price impact</span><b class="${impact > 1 ? 'down' : ''}">${impact.toFixed(3)}%</b></span>
          ${feeUi ? `<span><span class="dim">REX fee</span><b>${fmtNum(feeUi)} ${h(ti.symbol)}</b></span>` : ''}
          <span><span class="dim">Route</span><b>${(q.quote.routePlan || []).map((r) => h(r.swapInfo?.label || '')).filter(Boolean).join(' → ') || 'direct'}</b></span>
        </div>` : ''}
        ${err ? `<div class="fserr">${h(err)}</div>` : ''}
        ${noGas ? `<div class="fserr">This wallet has no SOL, so it cannot pay Solana's network fee — and the fee is charged
          in SOL even when the swap is how you were going to get some. Send about <b>${fmtNum(ready.floor / 1e9, 4)} SOL</b>
          to this wallet and the swap will go straight through.${from === DEFAULT_IN ? '' : ' Most of it comes back — it is a temporary deposit, not a cost.'}</div>` : ''}
        <button class="btn cta lg" id="swGo" style="width:100%;margin-top:12px" ${busy || !q || noGas ? 'disabled' : ''}><span>${
          !S.me ? 'Connect wallet to swap' : noGas ? 'No SOL for the network fee' : busy ? 'Working…' : q ? 'Swap' : 'Enter an amount'}</span></button>
        <div class="hint" style="margin-top:10px;text-align:center">Routes and settles on <b>Solana mainnet</b>, whatever network the rest of this site is on. Your wallet signs; nothing custodial.</div>
      </div></div>`;
    bind();
  };

  const quote = async () => {
    q = null; err = '';
    const fi = pick(from), ti = pick(to);
    const n = Number(amt);
    if (!fi || !ti || !(n > 0)) return draw();
    const base = Math.floor(n * 10 ** fi.decimals);
    if (!(base > 0)) return draw();
    try { q = await api('/api/jup/quote', { inputMint: from, outputMint: to, amount: base, slippageBps: 50 }); }
    catch (e) { err = niceErr(e); }
    draw();
  };

  let timer = null;
  const bind = () => {
    const a = $('#swAmt', root);
    if (a) a.oninput = (e) => { amt = e.target.value.replace(/[^\d.]/g, ''); clearTimeout(timer); timer = setTimeout(quote, 350); };
    const f = $('#swFlip', root); if (f) f.onclick = () => { const x = from; from = to; to = x; amt = ''; q = null; draw(); };
    $$('.tokpick', root).forEach((b) => b.onclick = () => openPicker(b.dataset.side));
    const go = $('#swGo', root); if (go) go.onclick = doSwap;
  };

  const openPicker = (side) => {
    const m = modal(`<h3>Select a token</h3>
      <div class="field" style="margin-top:10px"><input id="tokq" placeholder="Search name, symbol or paste a mint" autocomplete="off"></div>
      <div class="toklist" id="toklist"></div>`);
    const list = $('#toklist', m);
    const MINTRE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const paint = async (query) => {
      const s = query.trim();
      const low = s.toLowerCase();
      let hits = (s ? toks.filter((t) => t.symbol.toLowerCase().includes(low) || (t.name || '').toLowerCase().includes(low) || t.mint === s) : toks).slice(0, 60);
      // A mint the verified list does not carry is still swappable — Jupiter routes by address. Look
      // it up rather than saying "nothing matches" to someone who pasted a perfectly good token.
      if (!hits.length && MINTRE.test(s)) {
        list.innerHTML = '<div class="empty">Looking it up…</div>';
        try { const r = await api('/api/jup/token', { mint: s }); toks = [r.token, ...toks]; hits = [r.token]; }
        catch (e) { list.innerHTML = `<div class="empty">${h(niceErr(e))}</div>`; return; }
      }
      list.innerHTML = hits.map((t) => `<button data-m="${h(t.mint)}">${t.icon ? `<img src="${h(t.icon)}" alt="" loading="lazy">` : '<i class="dot"></i>'}
        <span><b>${h(t.symbol)}</b><small>${h(t.name || '')}${t.unverified ? ' · not on the verified list' : ''}</small></span><span class="dim mono">${h(t.mint.slice(0, 4))}…${h(t.mint.slice(-4))}</span></button>`).join('')
        || '<div class="empty">Nothing matches.</div>';
      $$('#toklist button', m).forEach((b) => b.onclick = () => {
        const mint = b.dataset.m;
        if (side === 'from') { if (mint === to) to = from; from = mint; } else { if (mint === from) from = to; to = mint; }
        closeModal(); q = null; draw(); if (amt) quote();
      });
    };
    paint('');
    $('#tokq', m).oninput = (e) => paint(e.target.value);
    $('#tokq', m).focus();
  };

  // The balance is read from the MAINNET connection, like everything else on this page — a devnet
  // balance would clear the check and then fail at broadcast. A failure here is left as null rather
  // than guessed: an unreachable RPC must not lock a funded wallet out of its own swap.
  const checkGas = async () => {
    if (!S.me?.wallet) { ready = null; return; }
    try { ready = await api('/api/jup/ready', { wallet: S.me.wallet }); }
    catch { ready = null; }
  };

  async function doSwap() {
    if (!S.me) return connectWallet();
    if (!q || busy) return;
    busy = true; err = ''; draw();
    try {
      const built = await api('/api/jup/swap', { quoteResponse: q.quote, userPublicKey: S.me.wallet });
      const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
      const raw = Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0));
      // Jupiter returns a versioned transaction; the legacy parser cannot read one.
      const tx = web3.VersionedTransaction.deserialize(raw);
      const signed = await CHAIN.signTx(tx);
      const { signature } = await api('/api/jup/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
      toast('gold', `Swapped · <a href="https://solscan.io/tx/${signature}" target="_blank" rel="noopener">view tx</a>`);
      amt = ''; q = null;
      checkGas().then(draw);                 // the SOL balance just moved, in either direction
    } catch (e) { err = niceErr(e); }
    busy = false; draw();
  }

  root.innerHTML = '<div class="fade"><div class="empty" style="margin-top:60px">Loading tokens…</div></div>';
  try {
    const r = await api('/api/jup/tokens');
    toks = r.tokens || [];
  } catch (e) { root.innerHTML = `<div class="fade"><div class="empty" style="margin-top:60px">Could not reach Jupiter: ${h(niceErr(e))}</div></div>`; return () => {}; }
  // A page that sends someone here for a specific asset — "you hold no ETH, go and get some" —
  // has to be able to say which, or the trip ends on a form they have to fill in themselves.
  const want = new URLSearchParams(location.search);
  const known = (mint) => mint && toks.some((t) => t.mint === mint) ? mint : null;
  from = known(want.get('from')) || DEFAULT_IN;
  to = known(want.get('to')) || (CA && toks.some((t) => t.mint === CA) ? CA : (toks.find((t) => t.symbol === 'USDC')?.mint || null));
  if (to === from) from = to === DEFAULT_IN ? (toks.find((t) => t.symbol === 'USDC')?.mint || DEFAULT_IN) : DEFAULT_IN;
  draw();
  checkGas().then(draw);
  // Connecting a wallet is how most people arrive at the funded-or-not question, so re-ask on it.
  const offAuth = bus.on('auth', () => checkGas().then(draw));
  return () => { clearTimeout(timer); offAuth(); };
}

/** Mirrors the server's badge rules so a profile and the board never disagree about a wallet. */
function badgesFor(rec, points = 0) {
  const b = [];
  if (rec?.neverSold && rec?.firstSeen) b.push('Never sold');
  if (rec?.tier) b.push(rec.tier);
  if ((rec?.coins || 0) >= 5) b.push('Collector');
  if (points >= 10_000) b.push('Grinder');
  return b;
}

/**
 * Paste-a-wallet lookup. Validates the shape before navigating, because sending someone to a page
 * for a malformed address just shows them an error with extra steps.
 */
function wireLookup(root) {
  const i = $('#lk', root), err = $('#lkerr', root); if (!i) return;
  const go = () => {
    const v = i.value.trim();
    if (!v) return;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) { if (err) err.textContent = "That does not look like a Solana address."; return; }
    if (err) err.textContent = '';
    history.pushState({}, '', '/u/' + v);
    dispatchEvent(new PopStateEvent('popstate'));
  };
  i.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  i.oninput = () => { if (err) err.textContent = ''; };
}

// ============================================================ WELCOME
// The first thing a new wallet sees. A wallet address is not a person, and until somebody picks a
// handle every trade tape, holder list and leaderboard shows them as `7xKq…9Fm2` — which is nobody.
// This runs ONCE, keyed on whether a profile has ever been saved rather than on whether a name
// exists, because a name can arrive without its owner having chosen it.
//
// If they hold a REX NFT, that is the profile picture offered first. They already own the art and
// they already made the choice; asking them to upload a file instead would be asking twice.
export async function welcome(root, { onDone } = {}) {
  if (!S.me) return () => {};
  let nfts = [], pick = null, file = null;
  // Read fresh rather than trusting the copy on S.me: this screen is also the editor, and editing
  // against a stale copy is how a form silently reverts a change made a minute ago.
  let p = S.me.profile || {};
  try { p = (await api('/api/me/profile')).profile; S.me.profile = p; } catch {}
  // The same screen serves first-run and editing. Prefilling from the existing profile is what makes
  // that safe: a blank edit form that posts every field would quietly erase whatever it did not show.
  const editing = !!p.setup;
  const form = { name: p.named ? p.name : '', bio: p.bio || '', x: p.x || '', telegram: p.telegram || '' };
  if (p.avatar) file = p.avatar;

  const draw = () => {
    root.innerHTML = `<div class="fade wrap-narrow" style="max-width:560px;margin:0 auto;padding:28px 0">
      <div style="text-align:center">
        <div class="ic-404">${icon('rex')}</div>
        <h1 style="font-size:32px;margin-top:8px">${editing ? 'Your profile' : 'Welcome to REX'}</h1>
        <p class="muted" style="margin-top:8px">${editing ? 'This is how you appear on every trade, holder list and leaderboard.' : 'Pick a name so people know who they are trading with. You can change it later.'}</p>
      </div>

      <div class="panel pad" style="margin-top:22px">
        <div class="row" style="gap:16px;align-items:center">
          <div id="pfp" class="av lg" style="display:grid;place-items:center;font-size:30px;background:linear-gradient(135deg,#1c1f2a,#0f1117);overflow:hidden">${
            pick ? `<img src="${h(pick.image)}" alt="" style="width:100%;height:100%;object-fit:cover">`
            : file ? `<img src="${h(file)}" alt="" style="width:100%;height:100%;object-fit:cover">` : icon('flame')}</div>
          <div style="flex:1;min-width:0">
            <div class="field"><input id="nm" maxlength="16" placeholder="name — letters, numbers, _" value="${h(form.name)}"></div>
            <div class="hint" style="margin-top:6px">This is the name on your trades and on the leaderboard.</div>
          </div>
        </div>

        <div id="nftbox" style="margin-top:16px"></div>

        <div class="field" style="margin-top:14px"><textarea id="bio" maxlength="160" rows="2" placeholder="A line about you (optional)">${h(form.bio)}</textarea></div>
        <div class="row wrap" style="gap:10px;margin-top:10px">
          <div class="field" style="flex:1 1 170px"><input id="x" maxlength="32" placeholder="X handle (optional)" value="${h(form.x)}"></div>
          <div class="field" style="flex:1 1 170px"><input id="tg" maxlength="32" placeholder="Telegram (optional)" value="${h(form.telegram)}"></div>
        </div>
        <div class="row" style="gap:10px;margin-top:16px">
          <button class="btn cta" id="go" style="flex:1"><span>${editing ? 'Save' : 'Create profile'}</span></button>
          <button class="btn ghost" id="skip">${editing ? 'Cancel' : 'Skip'}</button>
        </div>
        <label class="btn ghost sm" style="margin-top:10px;display:inline-block">Upload a picture instead
          <input type="file" id="up" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
      </div>
    </div>`;
    wire();
  };

  // The NFT row only appears when there is something in it. An empty "your REX NFTs" panel reads as
  // broken to the many people who do not hold one.
  const drawNfts = () => {
    const box = $('#nftbox', root); if (!box) return;
    if (!nfts.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="hint" style="margin-bottom:8px">You hold a REX NFT — use it as your picture</div>
      <div class="row wrap" style="gap:8px">${nfts.map((n, i) =>
        `<button class="nftpick${pick?.mint === n.mint ? ' on' : ''}" data-i="${i}" title="${h(n.name)}"><img src="${h(n.image)}" alt="${h(n.name)}" loading="lazy"></button>`).join('')}</div>`;
    box.querySelectorAll('.nftpick').forEach((b) => { b.onclick = () => { const n = nfts[+b.dataset.i]; pick = pick?.mint === n.mint ? null : n; file = null; draw(); drawNfts(); }; });
  };

  function wire() {
    drawNfts();
    const nm = $('#nm', root);
    $('#up', root).onchange = (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      if (f.size > 1_800_000) return toast('err', 'Image too large (max 1.8 MB)');
      const r = new FileReader(); r.onload = () => { file = r.result; pick = null; form.name = nm.value; draw(); }; r.readAsDataURL(f);
    };
    $('#skip', root).onclick = () => onDone?.();
    $('#go', root).onclick = async () => {
      const btn = $('#go', root); btn.disabled = true;
      try {
        const body = { name: nm.value, bio: $('#bio', root).value, x: $('#x', root).value, telegram: $('#tg', root).value };
        // One of the two, never both: whichever the person actually chose last.
        if (pick) body.avatarNft = pick.mint;
        else if (file && file !== p.avatar) body.avatar = file;   // unchanged picture: say nothing, change nothing
        const r = await api('/api/me/profile', body);
        S.me.profile = r.profile; S.me.name = r.profile.name;
        bus.emit('auth', S.me);
        toast('gold', editing ? 'Profile saved' : 'Profile created');
        onDone?.();
      } catch (e) { toast('err', niceErr(e)); btn.disabled = false; }
    };
  }

  draw();
  // Loaded after the first paint: scanning a wallet for NFTs is two RPC round trips, and the name
  // field should be usable immediately rather than waiting on it.
  try { const r = await api('/api/me/nfts'); nfts = r.nfts || []; if (nfts.length) { pick = nfts[0]; draw(); } } catch {}
  return () => {};
}

// ============================================================ POINTS
// Every bit of engagement on one board. Three views because they answer genuinely different
// questions — who has done the most, who has held longest, and who has never once sold — and the
// last two rank by TIME, not size, or it is just the rich list with a clock drawn on it.
export async function points(root) {
  let view = 'held';
  // "KING LIST" is Elio's name for the hold-time board and it is a better one than "Held longest" —
  // it says what being on it MEANS rather than how it is sorted. The view keys stay as they were so
  // links and the API do not break.
  const VIEWS = [['held', icon('crown') + 'King List', 'longest holders — ranked by time, not size'],
    ['diamond', 'Never sold', 'not one token has ever left'],
    ['points', 'All points', 'everything you have done']];

  const fmtPts = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toString();
  const held = (d) => d >= 1 ? `${Math.floor(d)}d` : d > 0 ? `${Math.max(1, Math.round(d * 24))}h` : '—';

  const row = (r) => `<div class="prow">
    <div class="pr-rank">${r.rank <= 3 ? [icon('medal', 'ic-gold'), icon('medal'), icon('medal', 'ic-bronze')][r.rank - 1] : '#' + r.rank}</div>
    <div class="pr-who">
      ${r.avatar ? `<img class="av" src="${h(r.avatar)}" alt="" loading="lazy" onerror="this.remove()">` : `<span class="av av-ph">${icon('rex')}</span>`}
      <div style="min-width:0">
        <a class="w" href="/u/${r.wallet}" data-link>${h(r.name || short(r.wallet))}</a>
        <div class="pr-badges">${r.badges.map((b) => `<span class="pb${b === 'Never sold' ? ' dia' : b === 'Original' ? ' og' : ''}">${h(b)}</span>`).join('')}</div>
      </div>
    </div>
    <div class="pr-held">${held(r.days)}<small>held</small></div>
    <div class="pr-pts">${fmtPts(r.points)}<small>pts</small></div>
  </div>`;

  // Where the points came from. A total nobody can account for is a number people stop believing.
  const breakdown = (b) => {
    const parts = [['Holding', b.holding], ['Buys', b.buys], ['Volume', b.volume], ['Launches', b.launches],
      ['Graduations', b.graduations], ['Fair Opens', b.fairOpens], ['Rewards claimed', b.claims],
      ['Referrals', b.referrals], ['Profile', b.profile], ['Picture', b.pfp]].filter(([, v]) => v > 0);
    return parts.length ? `<div class="pbreak">${parts.map(([k, v]) => `<span>${k}<b>${fmtPts(v)}</b></span>`).join('')}</div>` : '';
  };

  /**
   * Post & earn.
   *
   * ⛔ THE STATE THAT MATTERS IS "PENDING", AND IT HAS TO BE VISIBLE. Without X credentials the
   * server cannot read a post, so a submission waits for a human and is worth nothing until then.
   * A panel that showed a tick and a point total the instant you pasted a link would be lying in
   * the one direction that gets noticed — when the points never arrive.
   */
  const wireShare = async () => {
    const box = $('#shareBoost', root); if (!box) return;
    const list = $('#sbList', root), note = $('#sbNote', root), input = $('#sbUrl', root), go = $('#sbGo', root);
    const render = (d) => {
      $('#sbRate', root).textContent = fmtPts(d.pointsPerPost);
      $('#sbCap', root).textContent = `, up to ${d.dailyCap} a day`;
      note.innerHTML = d.autoVerify
        ? 'Posts are checked automatically — points land straight away.'
        : 'Each post is checked by hand before it counts, usually within a day.';
      list.innerHTML = (d.posts || []).length
        ? `<div class="sb-list">${d.posts.map((x) => `<div class="sb-row sb-${h(x.status)}">
            <a href="${h(x.url)}" target="_blank" rel="noopener nofollow">${h(x.handle ? '@' + x.handle : x.url.replace(/^https?:\/\//, ''))}</a>
            <span class="sb-when">${ago(x.ts)}</span>
            <span class="sb-st">${x.status === 'approved' ? `+${fmtPts(d.pointsPerPost)}` : x.status === 'pending' ? 'checking' : h(x.note || 'not counted')}</span>
          </div>`).join('')}</div>`
        : '';
    };
    const load = async () => { try { render(await api('/api/share')); } catch {} };
    const submit = async () => {
      const url = input.value.trim(); if (!url) return;
      go.disabled = true; go.firstChild.textContent = 'Checking…';
      try {
        const r = await api('/api/share', { url });
        input.value = '';
        toast(r.status === 'approved' ? 'gold' : 'ok', r.status === 'approved'
          ? `Counted — <b>+${fmtPts(r.points)}</b> points`
          : 'Submitted. It counts once it has been checked.');
        await load();
      } catch (e) { toast('err', niceErr(e)); }
      go.disabled = false; go.firstChild.textContent = 'Claim';
    };
    go.onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    load();
  };

  const draw = (d) => {
    const me = d.me;
    root.innerHTML = `<div class="fade">
      <div class="thead"><div><h1 style="font-size:30px">${icon('trophy')}Points</h1>
        <p class="muted" style="margin-top:6px">Every trade, every launch, every day you hold. Points are worked out from what actually happened on chain — nothing is awarded by hand, and selling does not take them away, it just stops the clock.</p></div></div>

      ${me ? `<div class="panel pad pme">
        <div class="pme-grid">
          <div><div class="l">Rank</div><div class="v">${me.rank ? '#' + me.rank : 'Unranked'}</div>
            <div class="hint">${me.rank ? `of ${me.of}` : 'buy or hold anything to join the board'}</div></div>
          <div><div class="l">Points</div><div class="v gold">${fmtPts(me.points)}</div></div>
          ${me.chase ? `<div class="chase"><div class="l">#${me.chase.rank} is ahead</div><div class="v">+${fmtPts(me.chase.gap)}</div><div class="hint">${h(me.chase.name || short(me.chase.wallet))}</div></div>` : ''}
        </div>
        ${me.badges?.length ? `<div class="pr-badges" style="margin-top:10px">${me.badges.map((b) => `<span class="pb">${h(b)}</span>`).join('')}</div>` : ''}
        ${(() => {
          // ⛔ THE TWO NUMBERS THAT MAKE THIS A FLYWHEEL RATHER THAN A SCOREBOARD: what your tier is
          // multiplying everything by, and what the people you invited are earning you. A board that
          // shows only a total tells somebody where they stand; these tell them what to do next.
          const b = d.breakdown;
          if (!b) return '';
          const pctToNext = b.toNextTier > 0 ? Math.max(2, Math.min(100, (b.base / (b.base + b.toNextTier)) * 100)) : 100;
          return `<div class="ptier">
            <div class="pt-row">
              <span class="pt-badge pt-${h(b.tier)}">${h(b.tierLabel)}</span>
              <span class="pt-mult">×${b.multiplier} on everything you earn</span>
              ${b.nextTier ? `<span class="pt-next">${fmtPts(b.toNextTier)} to ${h(b.nextTier)}</span>` : '<span class="pt-next">top tier</span>'}
            </div>
            <span class="prog"><i style="width:${pctToNext.toFixed(1)}%"></i></span>
            <div class="pt-down">
              <span>${b.invitees} invited</span>
              <span>earning you <b>${fmtPts(b.downline)}</b></span>
              <span class="dim">${(d.downline?.[0] ?? 0.1) * 100}% of theirs, ${(d.downline?.[1] ?? 0.05) * 100}% of their invitees'</span>
              <a class="btn sm" href="/growth" data-link>Invite</a>
            </div>
          </div>`;
        })()}
      </div>` : `<div class="panel pad"><div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <span class="muted">Connect a wallet to see where you rank.</span><button class="btn cta" id="pconn"><span>Connect wallet</span></button></div></div>`}

      ${/* POST & EARN. Elio, 7 Oct, pointing at @minersfamily: "How to implement this system like
            miner — to give people that share some points. We need bagwork incentives. People to post
            about us." Post on X, paste the link, earn points for it. */ ''}
      ${me ? `<div class="panel pad shareboost" id="shareBoost">
        <div class="sb-head"><div><h2>${icon('megaphone')}Post &amp; earn</h2>
          <p class="muted">Post about REX Chain on X, paste the link, and the post earns you points. <b id="sbRate">150</b> each<span id="sbCap"></span>.</p></div></div>
        <div class="sb-in"><input id="sbUrl" placeholder="https://x.com/you/status/…" inputmode="url" autocomplete="off" spellcheck="false">
          <button class="btn cta" id="sbGo"><span>Claim</span></button></div>
        <div class="sb-note" id="sbNote"></div>
        <div id="sbList"></div>
      </div>` : ''}

      <div class="sec" style="margin-top:18px"><h2>Look up a wallet</h2></div>
      <div class="panel pad">
        <div class="field lookup"><input id="lk" placeholder="paste a wallet address" spellcheck="false"></div>
        <div class="hint" id="lkerr" style="margin-top:6px;min-height:16px">Anyone's points, hold time and badges — no wallet connection needed.</div>
      </div>

      <div class="sec" style="margin-top:18px"><h2>The board</h2></div>
      <div class="opts" id="pviews">${VIEWS.map(([k, label, sub]) => `<button data-v="${k}" class="${k === view ? 'on' : ''}"><span>${label}</span><small>${sub}</small></button>`).join('')}</div>
      <div class="row wrap" style="gap:18px;margin:12px 0" id="pstats">
        <span class="muted">${d.stats.wallets} holders</span>
        <span class="muted">${d.stats.neverSold} never sold</span>
        <span class="muted">longest held ${held(d.stats.longestDays)}</span>
      </div>
      <div class="panel" id="pboard">${d.rows.length ? d.rows.map(row).join('') : '<div class="empty">Nobody on this board yet.</div>'}</div>

      ${me ? `<div class="sec" style="margin-top:18px"><h2>Where yours came from</h2></div>
        <div class="panel pad">${breakdown(d.me.breakdown || {}) || '<span class="muted">Trade, launch or hold something and it will show up here.</span>'}</div>` : ''}

      <div class="sec" style="margin-top:18px"><h2>Earning more</h2></div>
      <div class="panel pad"><div class="pbreak earn">
        ${[['Hold', 'value × days, multiplied by your conviction tier'], ['Buy', `${d.rates.buy} a trade, plus ${d.rates.volumePerUsd} per $ of volume`],
          ['Launch a coin', d.rates.launch], ['Get one to graduate', d.rates.graduated], ['Commit to a Fair Open', d.rates.fairOpen],
          ['Claim a reward', d.rates.claim], ['Refer someone who sticks', d.rates.referral],
          ['Set a name', d.rates.profile], ['Add a profile picture', d.rates.pfp]]
          .map(([k, v]) => `<span>${k}<b>${typeof v === 'number' ? '+' + v : ''}</b>${typeof v === 'string' ? `<small>${h(v)}</small>` : ''}</span>`).join('')}
      </div></div>

      <div class="panel pad soon" style="margin-top:14px">
        <div class="row" style="gap:12px;align-items:center"><span class="ic-lg">${icon('gift')}</span>
          <div><b>Loot boxes</b> <span class="chip">coming soon</span>
          <div class="hint" style="margin-top:4px">Streaks will open boxes. Nothing to buy and nothing to enter — this is a placeholder, not a live mechanic.</div></div></div>
      </div>
    </div>`;

    $('#pconn', root)?.addEventListener('click', connectWallet);
    wireShare();
    wireLookup(root);
    $$('#pviews button', root).forEach((b) => { b.onclick = () => { if (b.dataset.v === view) return; view = b.dataset.v; load(); }; });
  };

  const load = async () => {
    try { const d = await api(`/api/points?view=${view}&limit=50`); if (d.me) d.me.breakdown = (await api('/api/points/me').catch(() => ({})))?.breakdown; draw(d); }
    catch (e) { root.innerHTML = `<div class="empty">${h(niceErr(e))}</div>`; }
  };
  await load();
  const off = bus.on('auth', load);
  return () => off();
}

// ---------- the pairs board
// Julz's ranking: one table, six ways in, four windows. The design decision worth stating is that
// the window drives EVERY column it can — pick 7D and the volume, the rewards and the realized
// yield are all 7-day figures, not a 7-day sort over 24-hour numbers. A board whose heading and
// whose cells disagree is worse than no board, because it is wrong in a way nobody can see.
const PAIR_TABS = [
  { k: 'volume',  label: 'Volume',       icon: 'M3 20h3V9H3zm5.5 0h3V4h-3zM14 20h3v-8h-3zm5.5 0h3V7h-3z' },
  { k: 'mcap',    label: 'Market Cap',   icon: 'M5 18h14l-2.2-7.2-3.4 2.6L12 7l-1.4 6.4-3.4-2.6z' },
  { k: 'rewards', label: 'Rewards Paid', icon: 'M12 5c4 0 7 1.1 7 2.5S16 10 12 10 5 8.9 5 7.5 8 5 12 5m7 5.5c0 1.4-3 2.5-7 2.5s-7-1.1-7-2.5M19 14c0 1.4-3 2.5-7 2.5S5 15.4 5 14' },
  { k: 'apy',     label: 'Realized APY', icon: 'M7 17 17 7M8.5 8.5a1.5 1.5 0 1 1 0-.01M15.5 15.5a1.5 1.5 0 1 1 0-.01' },
  { k: 'gainers', label: 'Top Gainers',  icon: 'm4 16 5-5 3.5 3.5L20 7m0 0h-4.5M20 7v4.5' },
  { k: 'new',     label: 'Newest Pairs', icon: 'M12 3 5 7v10l7 4 7-4V7zm0 0v18' },
];
const PAIR_WINS = [['24h', '24H'], ['7d', '7D'], ['30d', '30D'], ['all', 'ALL']];
const WIN_LABEL = { '24h': '24H', '7d': '7D', '30d': '30D', all: 'ALL' };
// Gold, silver, bronze. Rank is earned by whatever is being sorted on, so the crown moves with the
// tab rather than being a permanent fixture on whoever has the biggest cap.
const CROWN = (i) => `<svg class="crown c${i + 1}" viewBox="0 0 24 24" width="17" height="17"><path d="M3 17h18l-1.6-8.4-4.6 3.4L12 5l-2.8 7-4.6-3.4z"/></svg>`;

/**
 * The basket — pick several coins, buy them in one pass.
 *
 * ⛔ IT IS N SIGNATURES, NOT ONE, AND IT SAYS SO. A Meteora swap carries enough accounts that two
 * of them will not fit in a single Solana transaction, let alone five, so an atomic basket is not
 * on offer here and pretending otherwise would be the sort of promise that reaches a user as "it
 * only bought three of them". Each coin is its own build-simulate-sign-send through the same
 * `act()` every single buy already uses — no new money path, nothing custodied, and the run can be
 * stopped between coins with everything already bought still bought.
 *
 * Progress is per coin and failures do not abort the rest: one coin whose pool is unreadable
 * should not cost you the other four.
 */
const BASKET_KEY = 'rex_basket';
export function basketRead() {
  try { const v = JSON.parse(localStorage.getItem(BASKET_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
export function basketWrite(list) {
  try { localStorage.setItem(BASKET_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* private window */ }
  bus.emit('basket');
}
export function basketAdd(t) {
  const list = basketRead();
  if (!t?.mint || list.some((x) => x.mint === t.mint)) return list.length;
  // Carry the quote and venue with the entry. Looking them up later means depending on whichever
  // list happens to be loaded when the basket is opened, and the basket outlives a page.
  list.push({ mint: t.mint, symbol: t.symbol, quote: t.quote, venue: t.venue || 'dbc', amount: 0 });
  basketWrite(list);
  toast(`${t.symbol} added to the basket`);
  return list.length;
}

export async function basket(root) {
  const draw = async () => {
    const list = basketRead();
    if (!list.length) {
      root.innerHTML = `<div class="fade"><div class="eyelabel">Basket</div>
        <h1 style="margin-top:10px">Nothing in the basket yet.</h1>
        <p class="muted" style="margin-top:12px;max-width:620px">Add coins from the board or from a
          coin's own page, set an amount against each, and buy the lot in one pass.</p>
        <a class="btn cta" href="/" data-link style="margin-top:14px"><span>Find coins</span></a></div>`;
      return;
    }
    const rows = list;
    root.innerHTML = `<div class="fade">
      <div class="eyelabel">Basket</div>
      <h1 style="margin-top:10px">Buy the lot.</h1>
      <p class="muted" style="margin-top:12px;max-width:620px">Each coin is a separate signature —
        a Meteora swap is too large to share a transaction, so this is ${rows.length} prompts rather
        than one. You can stop between any of them and whatever has already bought stays bought.</p>
      <div class="panel pad" style="margin-top:14px">
        ${rows.map((r, i) => `<div class="row between brow" data-i="${i}" style="gap:10px;padding:8px 0">
          <span><b>$${h(r.symbol)}</b></span>
          <span class="row" style="gap:8px;align-items:center">
            <input class="inp bk-amt" data-i="${i}" inputmode="decimal" placeholder="0.00"
              value="${r.amount || ''}" style="width:120px;text-align:right">
            <span class="dim" style="min-width:52px">${h(r.quote)}</span>
            <button class="btn sm bk-rm" data-i="${i}"><span>remove</span></button>
          </span>
          <span class="bk-state dim" data-i="${i}"></span>
        </div>`).join('')}
        <button class="btn cta" id="bkGo" style="margin-top:12px"><span>Buy ${rows.length} coin${rows.length === 1 ? '' : 's'}</span></button>
        <div class="hint" id="bkNote" style="margin-top:8px"></div>
      </div></div>`;

    root.querySelectorAll('.bk-rm').forEach((b) => { b.onclick = () => {
      const l = basketRead(); l.splice(Number(b.dataset.i), 1); basketWrite(l); draw();
    }; });
    root.querySelectorAll('.bk-amt').forEach((inp) => { inp.onchange = () => {
      const l = basketRead(); const i = Number(inp.dataset.i);
      if (l[i]) { l[i].amount = Number(inp.value) || 0; basketWrite(l); }
    }; });

    const go = $('#bkGo', root);
    if (go) go.onclick = async () => {
      const l = basketRead().filter((x) => Number(x.amount) > 0);
      if (!l.length) { toast('Set an amount against at least one coin'); return; }
      go.disabled = true;
      let done = 0, failed = 0;
      for (const it of l) {
        const cell = root.querySelector(`.bk-state[data-i="${basketRead().findIndex((x) => x.mint === it.mint)}"]`);
        const say = (t) => { if (cell) cell.textContent = t; };
        try {
          say('signing…');
          // ⛔ DECIMALS FROM THE QUOTE TABLE, AND NEVER A `|| 6`. That default is the exact
          // mechanism by which STONK and ZCAT were priced a thousand-fold wrong, so a quote whose
          // decimals we cannot read is refused rather than guessed at.
          const dec = quoteOf(it.quote)?.decimals;
          if (!Number.isInteger(dec)) throw new Error(`Cannot read how many decimals ${it.quote} uses — skipped`);
          const raw = Math.floor(Number(it.amount) * 10 ** dec);
          if (it.venue === 'dbc') {
            await CHAIN.act('dbc-buy', { mint: it.mint, amountIn: raw, minimumAmountOut: 0 });
          } else {
            await CHAIN.act('buy', { mint: it.mint, quoteIn: raw, minTokensOut: 0 });
          }
          say('bought'); done++;
        } catch (e) {
          // ⛔ ONE BAD COIN MUST NOT COST YOU THE REST. A pool that will not read, a rule that was
          // never switched on, a declined signature — none of them is a reason to abandon the
          // other four, so each is reported against its own row and the pass continues.
          say(niceErr(e)); failed++;
        }
      }
      go.disabled = false;
      $('#bkNote', root).textContent = `${done} bought${failed ? `, ${failed} did not — see each row` : ''}.`;
      if (done) toast(`Bought ${done} of ${l.length}`);
    };
  };
  await draw();
}

export async function pairs(root) {
  let sort = localStorage.getItem('rex_pairs_sort') || 'volume';
  let win = localStorage.getItem('rex_pairs_win') || '24h';
  let q = '', data = null, timer = null, searchT = null;

  // ⛔ `n >= 0` is TRUE for null, so an unmeasurable window printed "+0.0%" in green. Reuse pct(),
  // which already renders null and non-finite as "—".
  const signed = (n, dp = 1) => pct(n, dp);
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'dim');

  const load = async () => {
    try { data = await api(`/api/pairs?sort=${sort}&window=${win}${q ? `&q=${encodeURIComponent(q)}` : ''}`); }
    catch (e) { data = { pairs: [], totals: {}, error: niceErr(e) }; }
    draw();
  };

  const draw = () => {
    const rows = data?.pairs || [], t = data?.totals || {};
    root.innerHTML = `<div class="fade pairspage">
      <div class="sec"><div><h1>Pairs</h1>
        <p class="muted" style="margin-top:6px">Every coin paired against $REX, ranked. Volume, rewards and realized yield all follow the window you pick.</p></div></div>

      <div class="ptabs">${PAIR_TABS.map((x) => `<button data-s="${x.k}" class="${x.k === sort ? 'on' : ''}">
        <svg viewBox="0 0 24 24" width="15" height="15"><path d="${x.icon}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>${x.k === 'volume' ? `${WIN_LABEL[win]} ${x.label}` : x.label}</span></button>`).join('')}</div>

      <div class="prow2">
        <div class="pwins">${PAIR_WINS.map(([k, l]) => `<button data-w="${k}" class="${k === win ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="psearch"><svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" d="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-4.3-4.3"/></svg>
          <input id="pq" placeholder="Search pairs…" value="${h(q)}" autocomplete="off"></div>
      </div>

      <div class="ptablewrap"><table class="ptable">
        <thead><tr>
          <th class="num">#</th><th>Pair</th><th class="r">Price</th><th></th>
          <th class="r sortable${sort === 'mcap' ? ' on' : ''}" data-s="mcap">Market cap</th>
          <th class="r sortable${sort === 'volume' ? ' on' : ''}" data-s="volume">${WIN_LABEL[win]} volume</th>
          <th class="r sortable${sort === 'rewards' ? ' on' : ''}" data-s="rewards">Rewards paid</th>
          <th class="r sortable${sort === 'apy' ? ' on' : ''}" data-s="apy">Realized APY</th>
          <th class="r">7D</th><th class="r">30D</th><th class="r">Holders</th><th></th>
        </tr></thead>
        <tbody>${rows.length ? rows.map((p, i) => `<tr data-m="${h(p.mint)}">
          <!-- ⛔ The crown used to REPLACE the rank. The column is headed "#", so the top three
               showed no number at all while every row below them did — Julz reported it as the
               ranking having disappeared, which is exactly how it reads. The medal is decoration on
               top of the rank, never instead of it. -->
          <td class="num">${i < 3 ? `${CROWN(i)}<span class="rk">${i + 1}</span>` : i + 1}</td>
          <td><a class="ppair" href="/t/${h(p.mint)}" data-link>${av(p, 'sm')}
            <span><b>${h(p.name || p.symbol)}</b><small>${h(p.symbol)} / ${h(p.quote)}</small></span></a></td>
          <td class="r"><span class="pprice">${fmtPrice(p.priceUsd)}</span><small class="${cls(p.chgWin)}">${signed(p.chgWin)}</small></td>
          <td class="pspark">${spark(p.spark, 64, 26)}</td>
          <td class="r">${fmtUsd(p.mcapUsd)}</td>
          <td class="r up">${fmtUsd(p.volWinUsd)}</td>
          <td class="r">${fmtUsd(p.paidWinUsd)}</td>
          <td class="r">${(p.apyWin * 100).toFixed(1)}%</td>
          <td class="r ${cls(p.chg7d)}">${signed(p.chg7d)}</td>
          <td class="r ${cls(p.chg30d)}">${signed(p.chg30d)}</td>
          <td class="r">${fmtNum(p.holders)}</td>
          <td class="r"><a class="btn sm ghost trade" href="/t/${h(p.mint)}" data-link>Trade</a></td>
        </tr>`).join('') : `<tr><td colspan="12"><div class="empty">${data?.error ? h(data.error) : q ? 'No pair matches that.' : 'No pairs yet.'}</div></td></tr>`}</tbody>
      </table></div>

      <div class="ptotals">
        ${[['Total ecosystem volume', fmtUsd(t.volumeUsd || 0), `${WIN_LABEL[win]} across ${fmtNum(t.pairs || 0)} pairs`],
           ['Total market cap', fmtUsd(t.mcapUsd || 0), 'every live pair'],
           ['Total rewards paid', fmtUsd(t.rewardsUsd || 0), `paid to holders in ${WIN_LABEL[win]}`],
           ['Avg realized APY', `${((t.avgApy || 0) * 100).toFixed(1)}%`, 'weighted by market cap']]
          .map(([l, v, s]) => `<div class="ptile"><span class="l">${l}</span><b>${v}</b><small>${s}</small></div>`).join('')}
      </div>
      <p class="hint" style="margin-top:12px">Realized APY is what was actually paid out in the window, annualised against the current market cap — not a projection. A pair that paid nothing shows zero.</p>
    </div>`;
    bind();
  };

  const bind = () => {
    $$('.ptabs button', root).forEach((b) => b.onclick = () => { sort = b.dataset.s; localStorage.setItem('rex_pairs_sort', sort); load(); });
    $$('.ptable th.sortable', root).forEach((b) => b.onclick = () => { sort = b.dataset.s; localStorage.setItem('rex_pairs_sort', sort); load(); });
    $$('.pwins button', root).forEach((b) => b.onclick = () => { win = b.dataset.w; localStorage.setItem('rex_pairs_win', win); load(); });
    const s = $('#pq', root);
    // One timer, not two. The first version assigned `searchT` twice without clearing it in
    // between, so every keystroke left an orphaned timer running and fired the search TWICE.
    // Redrawing also destroys the input, so the caret is put back where the typist left it —
    // otherwise it jumps to the end mid-word on every debounce.
    if (s) s.oninput = (e) => {
      q = e.target.value;
      const at = e.target.selectionStart;
      clearTimeout(searchT);
      searchT = setTimeout(async () => {
        await load();
        const n = $('#pq', root);
        if (n) { n.focus(); n.setSelectionRange(at, at); }
      }, 300);
    };
  };

  root.innerHTML = '<div class="fade"><div class="empty" style="margin-top:60px">Loading pairs…</div></div>';
  await load();
  // The board is a market view, so it refreshes itself — but only while it is on screen.
  // A 20s poll is the floor, not the plan. ⛔ Until the Meteora indexer started broadcasting, a
  // swap on a dbc coin reached the database and nothing else — so this board only ever changed on
  // the poll, and looked stale next to a chart that was moving. Now a trade refreshes it at once,
  // debounced so a burst of fills is one redraw rather than thirty.
  let liveT = null;
  const live = () => { clearTimeout(liveT); liveT = setTimeout(() => { if (!document.hidden) load(); }, 1200); };
  const offs = [bus.on('trade', live), bus.on('token', live), bus.on('graduated', live)];
  timer = setInterval(() => { if (!document.hidden) load(); }, 20_000);
  return () => { clearInterval(timer); clearTimeout(searchT); clearTimeout(liveT); offs.forEach((f) => f()); };
}

/**
 * The creator dashboard: every coin you launched, what it has earned you, and the button that
 * actually pays it out.
 *
 * ⛔ THE ONE THING THIS PAGE MUST GET RIGHT IS WHERE A COIN'S CREATOR FEE LIVES.
 * On our own curve it accrues into `creator_pot` in our database, because our program splits each
 * swap into five buckets we control. On Meteora it accrues ON THE POOL ACCOUNT and our database
 * never sees a cent of it — $REXWEEN sat on 193.84 REX of unclaimed creator fees while our own
 * `trades` count for it still read 0. Reading the wrong source does not produce an error, it
 * produces a confident zero next to real money, so the venue decides both the figure AND the claim
 * route, on every single row.
 */
export async function creator(root) {
  root.innerHTML = '<div class="fade"><div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:320px"></div></div>';
  if (!S.me) {
    root.innerHTML = `<div class="fade"><div class="eyelabel">Creator</div>
      <h1 style="margin-top:10px;font-size:34px">Your coins, and what they pay you.</h1>
      <p class="muted" style="font-size:15.5px;margin-top:10px;max-width:640px">Every coin you launch charges a fee on each swap, and your share of it is yours to take whenever you like. Connect the wallet you launched with to see it.</p>
      <div class="panel pad" style="margin-top:18px"><button class="btn gold" id="cwal">Connect wallet</button></div></div>`;
    // ⛔ connectWallet(), NOT the no-wallet dialog. This button said "No Solana wallet detected"
    // to anybody who pressed it, Phantom installed or not — it announced the failure instead of
    // trying. connectWallet looks for a provider and only raises that dialog when there is none.
    $('#cwal', root).onclick = () => connectWallet();
    return;
  }

  let d;
  try { d = await api(`/api/creator?wallet=${S.me.wallet}`); }
  catch (e) { root.innerHTML = `<div class="fade"><div class="empty">Could not load your coins — ${h(niceErr(e))}</div></div>`; return; }

  const T = d.totals;
  const money = (c) => (c.claimable == null ? null : c.claimable.quote);

  const row = (c) => {
    const amt = money(c);
    const canClaim = amt != null && amt > 0;
    return `<tr data-mint="${h(c.mint)}">
      <td><a class="row" href="/t/${h(c.mint)}" data-link>${av(c, 'sm')}<span><b>${h(c.name)}</b> <span class="muted">$${h(c.symbol)}/${h(c.quote)}</span></span></a></td>
      <td><span class="chip sm">${c.venue === 'dbc' ? 'Meteora' : 'REX curve'}</span></td>
      <td class="mono">${fmtUsd((c.volume || 0) * (c.quoteUsd || 0))}</td>
      <td class="mono">${c.holders || 0}</td>
      <td class="mono">${c.claimedViaSite ? fmtNum(c.claimedViaSite) + ' ' + h(c.quote) : '—'}</td>
      <td class="mono ${canClaim ? 'up' : ''}"><b>${amt == null ? '—' : fmtNum(amt) + ' ' + h(c.quote)}</b></td>
      <td><button class="btn sm" data-links="${h(c.mint)}">${c.website || c.twitter || c.telegram ? 'Edit' : 'Add'}</button></td>
      <td><button class="btn sm ${canClaim ? 'gold' : ''}" data-claim="${h(c.mint)}" ${canClaim ? '' : 'disabled'}>${canClaim ? 'Claim' : amt == null ? 'Unknown' : 'Nothing yet'}</button></td>
    </tr>`;
  };

  root.innerHTML = `<div class="fade">
    <div class="eyelabel">Creator</div>
    <h1 style="margin-top:10px;font-size:34px">Your coins, and what they pay you.</h1>
    <p class="muted" style="font-size:15.5px;margin-top:10px;max-width:700px">Every swap on a coin you launched charges a fee, and your share of it waits for you to take it. Nothing expires and nothing is held back — the figures below are read from the chain each time you open this page.</p>

    <div class="stats" style="margin-top:18px">
      <div class="k"><div class="l">Coins launched</div><div class="v">${T.launches}</div></div>
      <div class="k"><div class="l">Claimable now</div><div class="v gold">${fmtUsd(T.claimableUsd)}${T.unknown ? '+' : ''}</div></div>
      <div class="k"><div class="l">Claimed through here</div><div class="v">${fmtUsd(T.claimedUsd)}</div></div>
      <div class="k"><div class="l">Volume you created</div><div class="v">${fmtUsd(T.volumeUsd)}</div></div>
    </div>
    ${T.unknown ? `<div class="hint" style="margin-top:8px">A pool did not answer just now, so "claimable" is a floor rather than a total — the rows showing <b>—</b> are unknown, not empty. Reload in a moment.</div>` : ''}

    <div class="sec" style="margin-top:22px"><h2>Your coins</h2></div>
    ${d.coins.length ? `<div class="panel"><table class="tbl">
      <thead><tr><th>Coin</th><th>Venue</th><th>Volume</th><th>Holders</th><th>Claimed</th><th>Claimable</th><th>Links</th><th></th></tr></thead>
      <tbody>${d.coins.map(row).join('')}</tbody></table></div>`
      : `<div class="empty">You have not launched a coin yet — <a href="/create" data-link class="gold">launch one</a>.</div>`}

    <div class="sec" style="margin-top:22px"><h2>How your cut works</h2></div>
    <div class="panel pad learn">
      <ul>
        <li>Your share is charged on the <b>quote</b> side of every swap, never in your own token — a coin is never sold to pay its creator.</li>
        <li>On Meteora the fee sits on the pool itself, so it survives anything that happens to this site, and it keeps earning after graduation instead of being burned with the liquidity.</li>
        <li>Claiming sends it straight to the wallet that launched the coin. Nobody else can claim it, including us.</li>
        <li>If you handed part of your cut to sharers on <a href="/growth" data-link>Grow</a>, their share is settled out of it before you see it here.</li>
      </ul>
    </div>
  </div>`;

  // ⛔ THE ONE PART OF A LAUNCH THAT IS NOT FIXED ONCE IT IS SIGNED, and until now the only part a
  // creator could never go back and set: the three link fields existed on the launch form and
  // nowhere else, so a coin launched without them stayed linkless for good. Most live coins are.
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-links]'); if (!b) return;
    const c = d.coins.find((x) => x.mint === b.dataset.links); if (!c) return;
    const m = modal(`<h3>Links for $${h(c.symbol)}</h3>
      <p class="muted" style="margin-top:6px;font-size:13.5px">These show on the coin page, and in the metadata JSON that wallets and scanners read — so adding one here reaches them too. Leave a field empty to take that link off.</p>
      <div class="field" style="margin-top:10px"><label>Website</label><input id="lkWeb" placeholder="https://" value="${h(c.website || '')}"></div>
      <div class="field"><label>Twitter / X</label><input id="lkX" placeholder="https://x.com/…" value="${h(c.twitter || '')}"></div>
      <div class="field"><label>Telegram</label><input id="lkTg" placeholder="https://t.me/…" value="${h(c.telegram || '')}"></div>
      <div class="row" style="margin-top:12px"><button class="btn gold" id="lkSave">Save</button><button class="btn" id="lkCancel">Cancel</button></div>
      <div class="hint" id="lkHint"></div>`);
    $('#lkCancel', m).onclick = () => closeModal();
    $('#lkSave', m).onclick = async () => {
      const btn = $('#lkSave', m), was = btn.textContent;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api('/api/creator/links', { mint: c.mint, website: $('#lkWeb', m).value, twitter: $('#lkX', m).value, telegram: $('#lkTg', m).value });
        // Take the SAVED values back, not what was typed: the server drops anything that is not a
        // http(s) link, and a row that kept the typed text would show a link the coin page will not.
        Object.assign(c, r.links);
        b.textContent = (c.website || c.twitter || c.telegram) ? 'Edit' : 'Add';
        closeModal(); toast('ok', 'Links saved');
      } catch (err) { btn.disabled = false; btn.textContent = was; $('#lkHint', m).textContent = niceErr(err); }
    };
  });

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-claim]'); if (!b) return;
    const mint = b.dataset.claim;
    const c = d.coins.find((x) => x.mint === mint); if (!c) return;
    const was = b.textContent;
    b.disabled = true;
    try {
      // The venue picks the route, exactly as it picks the figure above it.
      const what = c.venue === 'dbc' ? 'dbc-claim-creator' : 'claim-creator';
      const r = await CHAIN.act(what, { mint }, { onStage: (s) => { b.textContent = { building: 'Building…', checking: 'Checking…', signing: 'Confirm…', sending: 'Sending…', done: 'Done' }[s] || s; } });
      // Record what went out so the lifetime figure grows. The chain stays the authority on what is
      // still owed, so a failure here costs a number on a dashboard, never the money.
      // Send the SIGNATURE, not an amount: the server reads what actually moved out of the
      // transaction. A figure computed here was once 1000x out and the dashboard believed it.
      if (r?.signature) api('/api/chain/creator/claimed', { wallet: S.me.wallet, mint, sig: r.signature }).catch(() => {});
      toast('gold', `${icon('gem')}Claimed <b>${fmtNum(c.claimable?.quote || 0)} ${h(c.quote)}</b> · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">view tx</a>`, c.image);
      try { celebrate(); } catch {}
      creator(root);
    } catch (err) { toast('err', niceErr(err)); b.disabled = false; b.textContent = was; }
  });
}

/**
 * REX Chain's own income — what the protocol has earned, where it is sitting, and where it goes.
 *
 * ⛔ THIS IS THE PROTOCOL'S MONEY, NOT A LAUNCHER'S. A DBC swap fee splits three ways on the pool
 * account — creator, partner, protocol — and REX Chain is the PARTNER leg. `/creator` reads
 * `creatorQuoteFee` and this reads `partnerQuoteFee`: different fields on the same account, and
 * confusing them would either show a launcher the protocol's income or pay the protocol's cut to a
 * launcher. Measured on $REXWEEN, the split in force is 40 creator / 40 partner / 20 Meteora.
 *
 * The page is gated on the wallets the CHAIN says get paid, not on a list kept here.
 */
export async function earnings(root) {
  root.innerHTML = '<div class="fade"><div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:300px"></div></div>';
  if (!S.me) {
    root.innerHTML = `<div class="fade"><div class="eyelabel">Internal</div>
      <h1 style="margin-top:10px;font-size:34px">What REX Chain has earned.</h1>
      <p class="muted" style="font-size:15.5px;margin-top:10px;max-width:640px">Connect one of the wallets the protocol pays out to.</p>
      <div class="panel pad" style="margin-top:18px"><button class="btn gold" id="ewal">Connect wallet</button></div></div>`;
    $('#ewal', root).onclick = () => connectWallet();
    return;
  }

  let d;
  try { d = await api(`/api/earnings?wallet=${S.me.wallet}`); }
  catch (e) {
    root.innerHTML = `<div class="fade"><div class="eyelabel">Internal</div>
      <h1 style="margin-top:10px;font-size:34px">What REX Chain has earned.</h1>
      <div class="empty" style="margin-top:16px">${h(niceErr(e))}</div></div>`;
    return;
  }

  const T = d.totals, wf = d.waterfall;
  // Only coins that have something to say. A table of zeroes is noise, not information.
  const live = d.coins.filter((c) => c.partner?.quote > 0 || c.curve?.vaultPot > 0 || c.curve?.rexPot > 0 || c.trades > 0 || c.volume > 0);

  const row = (c) => {
    const amt = c.venue === 'dbc' ? c.partner?.quote : (c.curve ? (c.curve.vaultPot || 0) + (c.curve.rexPot || 0) : 0);
    const unknown = c.venue === 'dbc' && c.partner === null;
    return `<tr>
      <td><a class="row" href="/t/${h(c.mint)}" data-link>${av(c, 'sm')}<span><b>${h(c.name)}</b> <span class="muted">$${h(c.symbol)}/${h(c.quote)}</span></span></a></td>
      <td><span class="chip sm">${c.venue === 'dbc' ? 'Meteora' : 'REX curve'}</span></td>
      <td class="r mono">${c.trades || 0}</td>
      <td class="r mono">${fmtUsd((c.volume || 0) * (c.quoteUsd || 0))}</td>
      <td class="r mono ${amt > 0 ? 'up' : ''}"><b>${unknown ? '—' : fmtNum(amt || 0) + ' ' + h(c.quote)}</b><div class="dim" style="font-size:11px">${unknown ? 'unreadable' : fmtUsd((amt || 0) * (c.quoteUsd || 0))}</div></td>
      <td>${c.venue === 'dbc' && amt > 0 ? `<button class="btn sm gold" data-claimp="${h(c.mint)}">Claim</button>` : ''}</td>
    </tr>`;
  };

  root.innerHTML = `<div class="fade">
    <div class="eyelabel">Internal</div>
    <h1 style="margin-top:10px;font-size:34px">What REX Chain has earned.</h1>
    <p class="muted" style="font-size:15.5px;margin-top:10px;max-width:720px">The protocol's own cut of every swap, read from the chain. On Meteora it is the <b>partner</b> leg sitting on each pool; on our own curve it is the vault and $REX buckets. This is not a launcher's money — that is on <a href="/creator" data-link>the creator dashboard</a>.</p>

    <div class="stats" style="margin-top:18px">
      <div class="k"><div class="l">Earned to date</div><div class="v gold">${fmtUsd(T.earnedUsd)}${T.unknown ? '+' : ''}</div></div>
      <div class="k"><div class="l">Sitting unclaimed</div><div class="v">${fmtUsd(T.claimableUsd)}${T.unknown ? '+' : ''}</div></div>
      <div class="k"><div class="l">Volume across the pad</div><div class="v">${fmtUsd(T.volumeUsd)}</div></div>
      <div class="k"><div class="l">Swaps</div><div class="v">${T.trades}</div></div>
    </div>
    ${T.unknown ? `<div class="hint" style="margin-top:8px">A pool did not answer, so these are floors rather than totals — rows showing <b>—</b> are unknown, not zero.</div>` : ''}
    ${T.earnedUsd < 1 ? `<div class="hint" style="margin-top:8px">Small because almost nothing has traded yet: ${T.trades} swap${T.trades === 1 ? '' : 's'} across the whole pad.</div>` : ''}

    <div class="sec" style="margin-top:22px"><h2>Per coin</h2></div>
    ${live.length ? `<div class="panel"><table class="tbl">
      <thead><tr><th>Coin</th><th>Venue</th><th class="r">Swaps</th><th class="r">Volume</th><th class="r">Our cut</th><th></th></tr></thead>
      <tbody>${live.map(row).join('')}</tbody></table></div>`
      : `<div class="empty">Nothing has traded yet, so the protocol has earned nothing.</div>`}

    <div class="sec" style="margin-top:22px"><h2>Where it goes</h2></div>
    <div class="panel pad">
      <p class="muted" style="margin:0 0 12px">Read from the config account on chain, so this is the split actually in force — not a copy of it.</p>
      <table class="tbl"><thead><tr><th>Leg</th><th class="r">Share</th><th>Wallet</th></tr></thead><tbody>
        ${(wf?.legs || []).map((l) => `<tr><td><b>${h(l.label)}</b></td><td class="r mono">${(l.bps / 100).toFixed(1)}%</td><td class="mono dim">${h(l.wallet.slice(0, 8))}…${h(l.wallet.slice(-4))}</td></tr>`).join('')}
      </tbody></table>
      <div class="hint" style="margin-top:10px">${wf && wf.totalBps === 10000
        ? 'The legs sum to exactly 100%.'
        : `⛔ The legs sum to <b>${((wf?.totalBps || 0) / 100).toFixed(1)}%</b>, not 100% — a distribution would pay out the wrong amount.`}${wf?.paused ? ' The config is currently <b>paused</b>.' : ''}</div>
    </div>
  </div>`;

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-claimp]'); if (!b) return;
    const mint = b.dataset.claimp;
    const c = d.coins.find((x) => x.mint === mint); if (!c) return;
    const was = b.textContent; b.disabled = true;
    try {
      const r = await CHAIN.act('dbc-claim-partner', { mint }, { onStage: (s) => { b.textContent = { building: 'Building…', checking: 'Checking…', signing: 'Confirm…', sending: 'Sending…', done: 'Done' }[s] || s; } });
      toast('gold', `${icon('gem')}Claimed <b>${fmtNum(c.partner?.quote || 0)} ${h(c.quote)}</b> for the protocol · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">view tx</a>`, c.image);
      try { celebrate(); } catch {}
      earnings(root);
    } catch (err) { toast('err', niceErr(err)); b.disabled = false; b.textContent = was; }
  });
}

/* ---------------------------------------------------------------- feedback + admin (Elio, 5 Oct) */

/**
 * The feedback box: a rating, a suggestion or a bug report.
 *
 * ⛔ IT DOES NOT REQUIRE A WALLET. Elio asked for this because "feedback is important", and the
 * feedback that matters most comes from whoever just hit something broken — which, often enough,
 * is someone who could not connect a wallet in the first place. Gating it would silence exactly
 * the reports worth having.
 */
export function feedbackModal(kind = 'rating') {
  let rating = 0;
  const m = modal(`<div class="fb">
    <h3>${icon('star')}<span>Tell us how it is going</span></h3>
    <div class="fbtabs" id="fbTabs">
      <button data-k="rating" class="${kind === 'rating' ? 'on' : ''}"><span>Rate it</span></button>
      <button data-k="suggestion" class="${kind === 'suggestion' ? 'on' : ''}"><span>Suggestion</span></button>
      <button data-k="bug" class="${kind === 'bug' ? 'on' : ''}"><span>Report a bug</span></button>
    </div>
    <div id="fbStars" class="fbstars">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" aria-label="${n}">${icon('star')}</button>`).join('')}</div>
    <textarea id="fbText" maxlength="2000" placeholder="What happened, or what would you change?"></textarea>
    <div class="hint" id="fbHint"><span>Anonymous unless you are connected. We read every one.</span></div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn" id="fbCancel"><span>Cancel</span></button>
      <button class="btn cta" id="fbSend"><span>Send</span></button>
    </div></div>`);
  const $m = (sel) => m.querySelector(sel);
  let k = kind;
  const paint = () => {
    $$('#fbTabs button', m).forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    $m('#fbStars').hidden = k !== 'rating';
    $$('#fbStars button', m).forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= rating));
    $m('#fbText').placeholder = k === 'bug' ? 'What were you doing, and what went wrong?'
      : k === 'suggestion' ? 'What would you change?' : 'Anything you want to add (optional)';
  };
  $$('#fbTabs button', m).forEach((b) => b.onclick = () => { k = b.dataset.k; paint(); });
  $$('#fbStars button', m).forEach((b) => b.onclick = () => { rating = Number(b.dataset.n); paint(); });
  $m('#fbCancel').onclick = () => closeModal();
  $m('#fbSend').onclick = async () => {
    const btn = $m('#fbSend'); btn.disabled = true;
    try {
      await api('/api/feedback', { kind: k, rating: k === 'rating' ? rating : null, text: $m('#fbText').value, page: location.pathname });
      closeModal();
      toast('ok', k === 'bug' ? 'Thank you — that is logged and someone will look at it.' : 'Thank you — that is logged.');
    } catch (e) { toast('err', niceErr(e)); btn.disabled = false; }
  };
  paint();
}

/**
 * The admin panel. Gated server-side to the wallets the CHAIN names as payees — the client only
 * decides what to draw, never who is allowed, so a hidden button is not the security boundary.
 */
export async function admin(root) {
  root.innerHTML = '<div class="fade"><div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:320px"></div></div>';
  let d;
  try { d = await api('/api/admin/feedback'); }
  catch (e) {
    // ⛔ "NOT SIGNED IN" AND "NOT ALLOWED" ARE DIFFERENT PROBLEMS and this said the second for
    // both. The owner opened /admin, read "this page is for the wallets REX Chain pays out to"
    // and reasonably concluded the page was broken or their wallet was refused — when all that
    // had happened is that their session had lapsed and nothing was asking them to sign in.
    const signedOut = !S.me || /sign in/i.test(String(e?.message || ''));
    root.innerHTML = `<div class="empty">${signedOut
      ? `You are not signed in.<br><br><span class="hint">Connect your wallet with the button at the top right, then reload this page. Admin is for the wallets REX Chain pays out to, and for an owner key.</span>
         <div style="margin-top:14px"><button class="btn cta" id="admSignIn">Connect wallet</button></div>`
      : `${h(niceErr(e))}<br><br><span class="hint">Admin is for the wallets REX Chain pays out to, and for an owner key.</span>`}</div>`;
    const b = $('#admSignIn', root);
    if (b) b.onclick = () => connectWallet();
    return () => {};
  }
  const [inviters, sends] = await Promise.all([
    api('/api/ref/inviters').catch(() => ({ top: [] })),
    api('/api/payouts/sends').catch(() => ({ sends: [] })),
  ]);
  let filter = null;
  const render = () => {
    const rows = filter ? d.rows.filter((r) => r.status === filter) : d.rows;
    root.innerHTML = `<div class="fade">
      <div class="sec" style="margin-top:4px"><div><h1 style="font-size:30px">Admin</h1>
        <p class="muted" style="margin-top:6px">Inquiries, the referral programme and what has been paid out.</p></div></div>

      <!-- ⛔ THE CONTROL THAT SPENDS THE BURN POT WAS ON ANOTHER SITE BEHIND ANOTHER PASSWORD.
           The owner came looking for it here and found nothing, which is how a pot at 2.9x its
           threshold went eighteen days without a burn while the team read the unmoving date as
           the figures being wrong. It is first on the page because it is the only thing here
           that moves money on its own once it is on. -->
      <div class="panel pad" id="rwPanel" style="margin-bottom:12px">
        <div class="t">${icon('flame')}Rewards distributor — buybacks and burns</div>
        <div class="s" id="rwBody">Checking the rewards service…</div>
        <div id="rwPlan" style="margin-top:10px"></div>
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="btn go" id="rwAuto" style="display:none"></button>
          <button class="btn" id="rwRun" style="display:none"></button>
        </div>
      </div>

      <div class="panel pad" id="llPanel" style="margin-bottom:12px">
        <div class="t">${icon('rocket') || ''}Second launch venue — Raydium LaunchLab</div>
        <div class="s" id="llBody">Checking…</div>
        <button class="btn go" id="llGo" style="margin-top:10px;display:none"></button>
      </div>

      <div class="panel pad" id="topupPanel" style="margin-bottom:12px">
        <div class="t">${icon('gem')}Unblock launchers</div>
        <div class="s" id="topupBody">Checking who cannot claim…</div>
        <div id="topupList" style="margin-top:10px"></div>
        <button class="btn go" id="topupGo" style="margin-top:10px;display:none"></button>
      </div>

      <div class="stats">
        <div class="stat"><div class="l">New</div><div class="v gold">${fmtNum(d.counts.new || 0)}</div></div>
        <div class="stat"><div class="l">Seen</div><div class="v">${fmtNum(d.counts.seen || 0)}</div></div>
        <div class="stat"><div class="l">Done</div><div class="v">${fmtNum(d.counts.done || 0)}</div></div>
        <div class="stat"><div class="l">Average rating</div><div class="v">${d.avgRating ? d.avgRating.toFixed(2) + ' / 5' : '—'}</div><div class="s">${fmtNum(d.ratings)} rating${d.ratings === 1 ? '' : 's'}</div></div>
      </div>

      <div class="sec" style="margin-top:22px"><h2>${icon('chat')}Inquiries</h2>
        <div class="pwins" id="fbFilter">${[['', 'All'], ['new', 'New'], ['seen', 'Seen'], ['done', 'Done']].map(([v, l]) =>
          `<button data-v="${v}" class="${(filter || '') === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="panel">${rows.length ? `<table class="tbl">
        <tr><th>When</th><th>Kind</th><th>Rating</th><th>From</th><th>Message</th><th class="r">Status</th><th></th></tr>
        ${rows.map((r) => `<tr>
          <td class="dim" style="white-space:nowrap">${ago(r.ts)}</td>
          <td><span class="chip sm">${h(r.kind)}</span></td>
          <td>${r.rating ? '★'.repeat(r.rating) : '—'}</td>
          <td>${r.wallet ? `<a class="w" href="/u/${h(r.wallet)}" data-link>${h(r.who || short(r.wallet))}</a>` : '<span class="dim">anonymous</span>'}</td>
          <td style="max-width:420px">${h(r.text || '')}${r.page ? `<div class="hint">on ${h(r.page)}</div>` : ''}</td>
          <td class="r"><span class="chip sm ${r.status === 'new' ? 'ok' : ''}">${h(r.status)}</span></td>
          <td class="r"><button class="btn sm" data-id="${r.id}" data-next="${r.status === 'new' ? 'seen' : 'done'}">${r.status === 'new' ? 'Mark seen' : r.status === 'seen' ? 'Mark done' : 'Reopen'}</button></td>
        </tr>`).join('')}</table>` : '<div class="empty">Nothing here.</div>'}</div>

      <div class="sec" style="margin-top:22px"><h2>${icon('link')}Referral programme</h2><span class="muted" style="font-size:12.5px">Who is bringing wallets to REX Chain</span></div>
      <div class="panel">${inviters.top.length ? `<table class="tbl"><tr><th>#</th><th>Sharer</th><th class="r">Invited</th><th class="r">Volume</th><th class="r">Earned</th><th></th></tr>
        ${inviters.top.map((r, i) => `<tr><td class="num">${i + 1}</td>
          <td><a class="w" href="/u/${h(r.wallet)}" data-link>${h(r.who || short(r.wallet))}</a></td>
          <td class="r"><b>${fmtNum(r.invited)}</b></td><td class="r mono">${fmtNum(r.volume)}</td><td class="r mono gold">${fmtNum(r.earned)}</td>
          <td class="r"><a class="btn sm" href="/growth?w=${h(r.wallet)}" data-link>Tree</a></td></tr>`).join('')}</table>`
        : '<div class="empty">No referrals yet.</div>'}</div>

      <div class="sec" style="margin-top:22px"><h2>${icon('rex')}Payouts sent</h2><span class="muted" style="font-size:12.5px">Every transfer the protocol has made, from the chain's own record</span></div>
      <div class="panel">${sends.sends.length ? `<table class="tbl"><tr><th>When</th><th>Kind</th><th>Leg</th><th>To</th><th class="r">Raw</th><th class="r">State</th></tr>
        ${sends.sends.slice(0, 40).map((r) => `<tr><td class="dim">${ago(r.created_at)}</td><td><span class="chip sm">${h(r.kind)}</span></td>
          <td>${h(r.leg || '—')}</td><td class="mono">${h(short(r.dest))}</td><td class="r mono">${h(String(r.amount))}</td>
          <td class="r">${r.settled_at ? '<span class="chip sm ok">settled</span>' : r.failed_at ? '<span class="chip sm">failed</span>' : '<span class="chip sm">open</span>'}</td></tr>`).join('')}</table>`
        : '<div class="empty">Nothing has been paid out yet.</div>'}</div>
    </div>`;
    $$('#fbFilter button', root).forEach((b) => b.onclick = () => { filter = b.dataset.v || null; render(); });
    $$('button[data-next]', root).forEach((b) => b.onclick = async () => {
      b.disabled = true;
      try {
        const next = b.dataset.next === 'seen' ? 'seen' : b.textContent.includes('Reopen') ? 'new' : 'done';
        const r = await api('/api/admin/feedback', { id: Number(b.dataset.id), status: next });
        const row = d.rows.find((x) => x.id === r.row.id); if (row) Object.assign(row, r.row);
        d.counts = {}; for (const x of d.rows) d.counts[x.status] = (d.counts[x.status] || 0) + 1;
        render();
      } catch (e) { toast('err', niceErr(e)); b.disabled = false; }
    });
    // ⛔ THE PANELS ARE FILLED HERE, NOT BEFORE render(). render() REPLACES root.innerHTML, so a
    // mount that ran earlier found no element, returned silently, and left "Checking…" on screen
    // for ever with no error anywhere — signed in, page rendered, both panels dead. Running them
    // at the end of every render also keeps them alive when a filter button repaints the page.
    mountTopup();
    mountLaunchLab();
    mountRewards();
  };

  /**
   * One signature funds every launcher who cannot claim.
   *
   * ⛔ THE BROWSER NEVER NAMES AN ADDRESS OR AN AMOUNT. It asks the server "who is blocked" and
   * then "build it"; the server derives both from the chain. The last time this was done by hand
   * from a list, six of the seven were still short afterwards.
   */
  /**
   * The rewards distributor, driven from this page.
   *
   * ⛔ BOTH SWITCHES, SAID PLAINLY. The service needs mode `auto` AND not-paused before anything
   * is scheduled, and it had neither — so "AUTOMATIC" and "running" are not the same claim and
   * this must never imply they are. The pot and the split are shown beside the buttons because a
   * round sends real REX to real wallets the moment one is pressed.
   */
  async function mountRewards() {
    const body = $('#rwBody', root); if (!body) return;
    const plan = $('#rwPlan', root), bAuto = $('#rwAuto', root), bRun = $('#rwRun', root);
    let st;
    try { st = await api('/api/admin/rewards'); }
    catch (e) { body.innerHTML = `<span class="muted">The rewards service is not answering: ${h(niceErr(e))}</span>`; return; }

    const over = st.targetUsd > 0 && st.potUsd >= st.targetUsd;
    const burnPct = (st.buckets.find((b) => b.type === 'burnRex') || {}).pct || 0;
    body.innerHTML = st.running
      ? `<b>A round is running now</b> (${h(st.running.mode || '')}). Nothing else can start until it finishes.`
      : st.autoOn
        ? `<b>Automatic.</b> A round runs every ${st.intervalMinutes} min once the pot passes ${fmtUsd(st.targetUsd)}${st.nextRun ? ` · next check ${mmss(Math.max(0, st.nextRun - Date.now()))}` : ''}.`
        : `<b>Nothing is scheduled.</b> ${st.paused ? 'The service is paused' : 'The mode is manual'}, so a round only runs when someone presses Run here. The last was ${st.lastRoundAt ? ago(st.lastRoundAt) + ' ago' : 'never'}.`;

    plan.innerHTML = `<div class="hint">
      ${fmtUsd(st.potUsd)} in the pot${st.targetUsd ? ` · threshold ${fmtUsd(st.targetUsd)}${over ? ' · <b>past it</b>' : ''}` : ''}
      · ${fmtNum(st.potRex)} REX + ${st.potSol.toFixed(4)} SOL
      ${burnPct ? `<br>A round burns ${Math.round(burnPct * 100)}% of it — about ${fmtNum(st.potRex * burnPct)} REX at today's pot.` : ''}
      ${st.armed ? '' : '<br><b>Sending is not armed</b> on the rewards service, so a round would plan and send nothing.'}
    </div>`;

    bAuto.style.display = st.running ? 'none' : '';
    bAuto.textContent = st.autoOn ? 'Switch to manual' : 'Turn on automatic';
    bAuto.onclick = async () => {
      const next = st.autoOn ? 'manual' : 'auto';
      if (next === 'auto' && !confirm(`Automatic: the rewards service will run a round by itself every ${st.intervalMinutes} minutes whenever the pot is past ${fmtUsd(st.targetUsd)}, sending REX to holders and burning part of it, without anyone clicking. Turn it on?`)) return;
      bAuto.disabled = true; bAuto.textContent = 'Saving…';
      try { await api('/api/admin/rewards', { action: next }); toast(next === 'auto' ? 'Automatic is on' : 'Back to manual'); }
      catch (e) { toast(niceErr(e)); }
      bAuto.disabled = false; mountRewards();
    };

    bRun.style.display = st.running ? 'none' : '';
    bRun.textContent = 'Run one round now';
    bRun.onclick = async () => {
      if (!confirm(`Run a round now: ${fmtNum(st.potRex)} REX is split between holders, buyback, burn and the vault immediately. This sends real funds and cannot be undone. Continue?`)) return;
      bRun.disabled = true; bRun.textContent = 'Running — this takes a minute…';
      try {
        const r = await api('/api/admin/rewards', { action: 'run' });
        const res = r.result;
        toast(res?.round ? `Round ${res.round} sent` : res?.belowTarget ? 'Held: the pot is below its threshold' : 'Done');
      } catch (e) { toast(niceErr(e)); }
      bRun.disabled = false; mountRewards();
    };
  }

  async function mountTopup() {
    const body = $('#topupBody', root), list = $('#topupList', root), go = $('#topupGo', root);
    if (!body) return;
    let plan;
    try { plan = await api('/api/admin/topup'); }
    catch (e) { body.textContent = niceErr(e); return; }
    // ⛔ The plan reads a pool per launch and simulates a claim per launcher. The server answers at
    // once and keeps working, so poll rather than leaving a line that looks hung.
    if (plan.computing) {
      body.textContent = 'Reading every launcher\'s fees and testing their claim against the chain…';
      clearTimeout(mountTopup._t);
      mountTopup._t = setTimeout(mountTopup, 3000);
      return;
    }
    const sol = (l) => (l / 1e9).toFixed(5);
    if (!plan.rows.length) {
      body.textContent = plan.fine.length
        ? `All ${plan.fine.length} launcher${plan.fine.length === 1 ? '' : 's'} with fees waiting can already claim. Nothing to fund.`
        : 'No launcher has fees waiting right now.';
      list.innerHTML = ''; go.style.display = 'none'; return;
    }
    body.innerHTML = `<b>${plan.rows.length}</b> launcher${plan.rows.length === 1 ? ' cannot' : 's cannot'} claim fees they have already earned —`
      + ` a claim opens two token accounts and their wallet cannot cover the rent`
      + ` (${sol(plan.rentPerAccount)} SOL each, plus ${sol(plan.payerFloor)} the wallet must keep to stay open).`;
    list.innerHTML = plan.rows.map((r) => `<div class="row" style="display:flex;justify-content:space-between;gap:8px;padding:4px 0">
      <span class="dim" title="${h(r.wallet)}">${h(r.wallet.slice(0, 6))}…${h(r.wallet.slice(-4))} · ${h(r.coins.join(', '))}</span>
      <b>+${sol(r.send)} SOL</b></div>`).join('')
      + (plan.rows.some((r) => r.unverified) ? `<div class="hint" style="margin-top:8px">⛔ Some of these could not be re-simulated just now (the chain was busy), so they are included on their balance alone rather than being assumed fine.</div>` : '')
      + (plan.fine.length ? `<div class="hint" style="margin-top:8px">${plan.fine.length} other${plan.fine.length === 1 ? '' : 's'} already funded — not included.</div>` : '');
    go.style.display = '';
    go.textContent = `Send ${sol(plan.total)} SOL to all ${plan.rows.length}`;
    go.onclick = async () => {
      go.disabled = true;
      try {
        const r = await CHAIN.signServerTx('/api/admin/topup', {}, {
          // ⛔ The build re-reads every launcher's fees and re-simulates every claim — seventeen
          // seconds on a good day. A label that does not move for that long is a button the owner
          // reasonably reports as stuck, which is exactly what happened.
          onStage: (st) => { go.textContent = { building: 'Re-checking every launcher against the chain…', signing: 'Confirm in your wallet…', sending: 'Sending…', done: 'Sent' }[st] || st; },
        });
        toast('ok', `Funded ${r.count} launcher${r.count === 1 ? '' : 's'} · <a href="${CHAIN.explorer(r.signature)}" target="_blank" rel="noopener">view tx</a>`);
        await mountTopup();
      } catch (e) { toast('err', niceErr(e)); go.textContent = 'Try again'; }
      go.disabled = false;
    };
  }

  /**
   * Turn on the second venue.
   *
   * ⛔ Meteora refuses a quote mint that charges a transfer fee — $GP, $ZCAT, $MASK, $SI and
   * $ALLINU — so while DBC is the only venue those five pairs are impossible here. LaunchLab takes
   * them. Creating one account is what switches it on; the server signs with the fee claimer, so
   * there is nothing to approve in a wallet.
   */
  async function mountLaunchLab() {
    const body = $('#llBody', root), go = $('#llGo', root);
    if (!body) return;
    let st;
    try { st = await api('/api/admin/launchlab/platform'); }
    catch (e) { body.textContent = niceErr(e); return; }
    if (st.enabled) {
      const P = st.platform || {};
      body.innerHTML = `<b>On.</b> Platform <span class="dim">${h(String(st.id).slice(0, 8))}…</span> — `
        + `${h(String(P.feeBps ?? '?'))} bps to the site, ${h(String(P.creatorFeeBps ?? '?'))} bps to the launcher, `
        + `LP ${h(String(P.lp?.burn ?? '?'))}% burned.`
        + `<div class="hint" style="margin-top:6px">The launch form offers it automatically for any pair Meteora`
        + ` refuses — $GP today. Those chips read "via LaunchLab" instead of being greyed out.</div>`;
      go.style.display = 'none'; return;
    }
    body.innerHTML = `<b>Off.</b> Meteora will not take a quote mint that charges a transfer fee`
      + ` — that is $GP, $ZCAT, $MASK, $SI and $ALLINU, which is why they cannot be paired with today.`
      + ` Raydium's LaunchLab will. Turning it on creates one account, signed by the fee claimer.`
      + `<div class="hint" style="margin-top:6px">Pairs LaunchLab has a curve for: ${h((st.pairs || []).join(', '))}.`
      + ` 2% of each curve trade to the site, 0.5% to the launcher, LP burned at graduation.`
      + ` Creating the account costs about 0.0075 SOL from the fee claimer and turns the venue on immediately:`
      + ` $GP stops being greyed out in the launch form and launches here instead.</div>`;
    go.style.display = '';
    go.textContent = 'Create the platform';
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Reading the chain…';
      try {
        const plan = await api('/api/admin/launchlab/platform', {});
        if (!confirm(`Create the LaunchLab platform?\n\nAccount ${plan.id}\nRent about ${(plan.lamports / 1e9).toFixed(4)} SOL from the fee claimer.\n\nThis is one-time and cannot be undone.`)) {
          go.disabled = false; go.textContent = 'Create the platform'; return;
        }
        go.textContent = 'Creating…';
        const r = await api('/api/admin/launchlab/platform', { execute: true });
        toast('ok', r.existed ? 'The platform already existed — adopted it.' : 'LaunchLab venue is on.');
        await mountLaunchLab();
      } catch (e) { toast('err', niceErr(e)); go.textContent = 'Try again'; }
      go.disabled = false;
    };
  }

  render();
  return () => {};
}

/**
 * Open liquidity.
 *
 * ⛔ THE PAGE'S FIRST JOB IS TO SAY WHAT THIS IS NOT. Supplying liquidity is not a savings account
 * and the fee figures make it look like one. A depositor takes BOTH sides of the pair, the position
 * changes shape as the price moves, and if the coin falls they end up holding more of it than they
 * put in — impermanent loss, which no amount of fee income is guaranteed to cover. That sentence is
 * above the amount box, at full contrast, not in a tooltip under the button.
 *
 * Pools are DISCOVERED from the chain for whichever coin is chosen, because there is no configured
 * pool address in this deployment and inventing one would be the same mistake the vault refuses to
 * make, with somebody else's money.
 */
export async function liquidity(root) {
  const offs = [];
  let coins = [], mint = null, pools = [], pool = null, positions = [], plan = null, amount = '';
  let busy = false, err = null;

  root.innerHTML = `<div class="wrap">
    <section class="thead"><h1>Liquidity</h1>
      <p class="sub">Add liquidity to a pool and earn your share of the fee on every swap that trades through it. Withdraw whenever you like.</p></section>
    <div class="warn" style="margin:0 0 16px">${icon('flame')}<div><b>This is not a deposit account.</b>
      You supply <b>both</b> sides of the pair, and your position changes shape as the price moves — if the coin falls you will end up holding more of it
      than you put in. That is impermanent loss, and fee income is not guaranteed to cover it. Your liquidity is never locked: you can take it out at any time.</div></div>
    <div id="lpBody"><div class="skeleton"></div></div>
  </div>`;
  const body = $('#lpBody', root);

  // ⛔ NEVER ASSUME SIX DECIMALS. The amount box converts what somebody types into raw units, and a
  // SOL-paired pool is 9 — so a hardcoded 1e6 turns "1 SOL" into a thousandth of it, and an xStock
  // pair into a hundredth. Both sides' decimals come from the pool, and until they do there is no
  // conversion to make, so the box refuses rather than guessing.
  const decIn = () => (pool ? (pool.tokenBDecimals ?? null) : null);
  const decOther = () => (pool ? (pool.tokenADecimals ?? null) : null);
  const toRaw = (n, dec) => Math.floor(Number(n) * 10 ** dec);
  const fmtRaw = (raw, dec) => (dec == null ? '—' : (Number(raw || 0) / 10 ** dec).toLocaleString('en-US', { maximumFractionDigits: 6 }));

  function render() {
    const t = coins.find((c) => c.mint === mint);
    body.innerHTML = `
      <div class="sec"><h2>Pick a coin</h2></div>
      <div class="opts" id="lpCoin">${coins.map((c) => `<button data-v="${h(c.mint)}" class="${c.mint === mint ? 'on' : ''}"><span>$${h(c.symbol)}</span><small>${h(c.name || '')}</small></button>`).join('')
        || '<div class="empty">Nothing to add liquidity to yet.</div>'}</div>
      ${mint ? `
        <div class="sec"><h2>Pool</h2>${pools.length > 1 ? '<span class="muted">deepest first</span>' : ''}</div>
        ${pools.length ? `<div class="opts" id="lpPool">${pools.map((p) => `<button data-v="${h(p.pool)}" class="${p.pool === pool?.pool ? 'on' : ''}"><span class="mono">${h(p.pool.slice(0, 6))}…${h(p.pool.slice(-4))}</span><small>${Number(p.liquidity) > 0 ? 'depth ' + fmtNum(Number(p.liquidity) / 1e12) : 'depth not reported'}</small></button>`).join('')}</div>`
          : `<div class="empty">$${h(t?.symbol || '')} has no DAMM v2 pool yet. A coin gets one when it graduates off its bonding curve.</div>`}
        ${pool ? `
          <div class="sec"><h2>Add liquidity</h2></div>
          <div class="panel pad">
            <div class="field"><label>Amount <span class="dim">in the pair asset</span></label>
              <input id="lpAmt" type="text" inputmode="decimal" placeholder="0.0" value="${h(amount)}"></div>
            ${plan ? `<div class="hint">This also needs about <b>${fmtRaw(plan.otherAmount, decOther())}</b> of the other side, which comes from your wallet in the same transaction.</div>` : ''}
            ${decIn() == null ? '<div class="fserr">We could not read this pool\'s decimals, so the amount cannot be converted safely. Try again in a moment.</div>' : ''}
            ${err ? `<div class="fserr">${h(err)}</div>` : ''}
            <div class="actions"><button class="btn cta" id="lpAdd"${busy ? ' disabled' : ''}><span>${busy ? 'Working…' : 'Add liquidity'}</span></button></div>
          </div>` : ''}
        <div class="sec"><h2>Your positions</h2></div>
        ${positions.length ? `<div class="bf-list">${positions.map((p) => `<div class="bf-row" style="cursor:default">
            <span class="mono bf-sym">${h(p.position.slice(0, 6))}…</span>
            <span class="bf-buyer"><span class="bf-who">${Number(p.liquidity) > 0 ? 'depth ' + fmtNum(Number(p.liquidity) / 1e12) : 'position open'}</span>${p.permanentlyLocked ? '<span class="bf-tag">locked</span>' : '<span class="bf-tag"></span>'}</span>
            <span class="bf-size">${fmtRaw(p.feeB, decIn())}</span>
            <span class="bf-ago"><button class="btn sm" data-claim="${h(p.position)}" data-nft="${h(p.positionNftAccount)}" data-pool="${h(p.pool || '')}">Claim</button>${
              p.permanentlyLocked ? '' : `<button class="btn sm ghost" data-wd="${h(p.position)}" data-nft="${h(p.positionNftAccount)}" data-pool="${h(p.pool || '')}">Withdraw</button>`}</span>
          </div>`).join('')}</div>`
          : '<div class="empty">Nothing yet. Liquidity you add shows up here with the fees it has earned.</div>'}` : ''}`;
    bind();
  }

  async function loadPools() {
    pools = []; pool = null; plan = null;
    render();
    try {
      const d = await api('/api/lp/pools?mint=' + encodeURIComponent(mint));
      pools = d.pools || [];
      pool = pools[0] || null;
    } catch (e) { err = niceErr(e); }
    await loadPositions();
    render();
  }
  async function loadPositions() {
    positions = [];
    if (!S.me?.wallet || !mint) return;
    try { positions = (await api(`/api/lp/positions?wallet=${S.me.wallet}&mint=${mint}`)).positions || []; }
    catch { /* a position list that will not load must not blank the page */ }
  }

  function bind() {
    $$('#lpCoin button', body).forEach((b) => b.onclick = () => { mint = b.dataset.v; amount = ''; loadPools(); });
    $$('#lpPool button', body).forEach((b) => b.onclick = () => { pool = pools.find((x) => x.pool === b.dataset.v); plan = null; render(); });
    const amt = $('#lpAmt', body);
    if (amt) {
      let t = null;
      amt.oninput = () => {
        amount = amt.value; plan = null; err = null;
        clearTimeout(t);
        // Quoted as you type, debounced: the other side's amount is the number that decides whether
        // somebody can afford this at all, and finding it out only on the signature prompt is rude.
        t = setTimeout(async () => {
          const n = Number(amount);
          if (!(n > 0) || !pool) return;
          try {
            const d = decIn();
            if (d == null) { err = 'We could not read this pool\'s decimals yet.'; render(); return; }
            plan = await api('/api/lp/plan', { wallet: S.me?.wallet, pool: pool.pool, amount: toRaw(n, d) });
            err = null;
          } catch (e) { err = niceErr(e); }
          render();
          const el = $('#lpAmt', body); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 450);
      };
    }
    const add = $('#lpAdd', body);
    if (add) add.onclick = () => {
      const d = decIn();
      // Refuse rather than send a figure scaled by a guess — this is the step that moves money.
      if (d == null) { err = 'We could not read this pool\'s decimals, so the amount cannot be converted safely.'; return render(); }
      act('add', { pool: pool.pool, amount: toRaw(Number(amount), d) });
    };
    $$('[data-claim]', body).forEach((b) => b.onclick = () => act('claim', { pool: b.dataset.pool, position: b.dataset.claim, positionNftAccount: b.dataset.nft }));
    $$('[data-wd]', body).forEach((b) => b.onclick = () => act('withdraw', { pool: b.dataset.pool, position: b.dataset.wd, positionNftAccount: b.dataset.nft }));
  }

  async function act(action, args) {
    if (!S.me?.wallet) return connectWallet();
    busy = true; err = null; render();
    try {
      const built = await api('/api/lp/build', { wallet: S.me.wallet, action, ...args });
      // Same three steps as every other signed action on the site: deserialize, let the wallet sign,
      // hand it back for sending. The position-NFT keypair has already partial-signed server side.
      const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
      const tx = web3.Transaction.from(Uint8Array.from(atob(built.tx), (c) => c.charCodeAt(0)));
      const signed = await CHAIN.signTx(tx);
      await api('/api/chain/send', { tx: btoa(String.fromCharCode(...signed.serialize())) });
      toast('gold', action === 'add' ? 'Liquidity added' : action === 'claim' ? 'Fees claimed' : 'Liquidity withdrawn');
      amount = ''; plan = null;
      await loadPositions();
    } catch (e) { err = niceErr(e); }
    busy = false; render();
  }

  (async () => {
    // ⛔ $REX LEADS, AND WITHOUT IT THIS PAGE IS EMPTY. A REX Chain coin only gets a DAMM v2 pool
    // when it graduates off its bonding curve, and nothing has graduated yet — so a list built from
    // our own launches alone shows "no graduated coins" and the whole feature reads as unfinished.
    // $REX is the token the entire site is denominated in and it already has pools, which makes it
    // both the useful answer today and the one Elio actually asked for: liquidity in the project's
    // own token, open to anyone, earning a share of every trade.
    const rex = (S.quotes || []).find((q) => q.symbol === 'REX');
    if (rex?.mint) coins.push({ mint: rex.mint, symbol: 'REX', name: 'rex.fun' });
    try {
      const d = await api('/api/tokens?sort=mcap&status=graduated&limit=40');
      coins = coins.concat(d.tokens || []);
    } catch (e) { err = niceErr(e); }
    if (coins.length) { mint = coins[0].mint; await loadPools(); return; }
    render();
  })();
  offs.push(bus.on('auth', () => { loadPositions().then(render); }));
  return () => offs.forEach((f) => f());
}
