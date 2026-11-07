// The embeddable token card. A creator drops one <iframe> on their own site and it shows their
// live numbers, refreshing itself — and the Trade button carries whatever referral code the embed
// was built with, so traffic a creator sends from their own site comes back attributed.
//
// Served as a standalone document with no scripts from anywhere else: it is going into other
// people's pages, so it brings nothing with it and asks for nothing.
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K'
  : '$' + (Number(n) || 0).toFixed(2);

export const THEMES = ['dark', 'light'];

/**
 * @param t     a public token (from publicToken)
 * @param base  absolute origin, so links work from someone else's domain
 * @param opts  { theme, ref } — `ref` is the referral code the Trade button carries
 */
export function embedHtml(t, base, opts = {}) {
  const theme = THEMES.includes(opts.theme) ? opts.theme : 'dark';
  const ref = /^[23456789A-HJ-NP-Z]{6}$/.test(String(opts.ref || '')) ? opts.ref : null;
  const href = `${base}/t/${t.mint}${ref ? `?r=${ref}` : ''}`;
  const fees = t.fees || {};
  const light = theme === 'light';
  const img = t.image ? (t.image.startsWith('http') ? t.image : base + t.image) : null;

  return `<!doctype html>
<html lang="en" data-theme="${theme}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>$${esc(t.symbol)} on REX Chain</title>
<style>
  :root{
    --bg:${light ? '#ffffff' : '#0b100c'}; --fg:${light ? '#0b100c' : '#e9eef2'};
    --dim:${light ? '#5b6670' : '#7c8794'}; --line:${light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.1)'};
    --surface:${light ? 'rgba(0,0,0,.03)' : 'rgba(255,255,255,.04)'}; --accent:#22c55e; --gold:#9dff8f;
  }
  *{box-sizing:border-box;margin:0}
  /* Same rule as the site: a sized <img> with no object-fit stretches, and a flex item shrinks. */
  img{object-fit:contain;flex-shrink:0;max-width:100%}
  html,body{height:100%}
  body{background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       -webkit-font-smoothing:antialiased;padding:14px;display:flex;flex-direction:column;gap:12px}
  a{color:inherit;text-decoration:none}
  .top{display:flex;align-items:center;gap:10px;min-width:0}
  .art{width:44px;height:44px;border-radius:11px;object-fit:cover;background:var(--surface);flex:0 0 auto}
  .nm{min-width:0;flex:1 1 auto}
  .sym{font-weight:700;font-size:16px;letter-spacing:-.01em}
  .name{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .px{text-align:right;flex:0 0 auto}
  .mc{font-weight:700;font-size:17px;font-variant-numeric:tabular-nums}
  .chg{font-size:11.5px;font-variant-numeric:tabular-nums}
  .up{color:var(--accent)} .down{color:#ff5470}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .cell{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
  .cell .l{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
  .cell .v{font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}
  .cta{display:block;text-align:center;background:var(--accent);color:#06240f;font-weight:700;
       border-radius:11px;padding:10px;margin-top:auto;font-size:14px}
  .cta:hover{filter:brightness(1.07)}
  .ft{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:var(--dim)}
  .ft b{color:var(--accent)}
</style></head><body>
  <div class="top">
    ${img ? `<img class="art" src="${esc(img)}" alt="">` : '<div class="art"></div>'}
    <div class="nm"><div class="sym">$${esc(t.symbol)}</div><div class="name">${esc(t.name)}</div></div>
    <div class="px"><div class="mc" id="mc">${money(t.mcapUsd)}</div>
      <div class="chg ${t.chg24h == null ? 'dim' : t.chg24h >= 0 ? 'up' : 'down'}" id="chg">${t.chg24h == null ? '—' : `${t.chg24h >= 0 ? '+' : ''}${(t.chg24h * 100).toFixed(1)}% 24h`}</div></div>
  </div>
  <div class="row">
    <div class="cell"><div class="l">Holder rewards</div><div class="v" id="paid">${money((t.yieldPaid || 0) * (t.quoteUsd || 0))}</div></div>
    <div class="cell"><div class="l">Holders</div><div class="v" id="hold">${t.holders || 0}</div></div>
  </div>
  <a class="cta" href="${esc(href)}" target="_blank" rel="noopener">Trade $${esc(t.symbol)}</a>
  <div class="ft"><span>${fees.holderBps ? `${(fees.holderBps / 100).toFixed(1)}% of every swap to holders` : 'Sealed Fair Open'}</span><span><b>REX Chain</b></span></div>
<script>
// Refresh in place. Same-origin fetch back to the pad it came from; if it fails the card simply
// keeps the numbers it was rendered with rather than showing an error inside someone else's page.
(function () {
  var U = ${JSON.stringify(`${base}/api/tokens/${t.mint}`)};
  var money = function (n) { return n >= 1e9 ? '$' + (n/1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M'
    : n >= 1e3 ? '$' + (n/1e3).toFixed(1) + 'K' : '$' + (Number(n)||0).toFixed(2); };
  function tick() {
    fetch(U, { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }).then(function (d) {
      var t = d && d.token; if (!t) return;
      document.getElementById('mc').textContent = money(t.mcapUsd);
      document.getElementById('paid').textContent = money((t.yieldPaid || 0) * (t.quoteUsd || 0));
      document.getElementById('hold').textContent = t.holders || 0;
      var c = document.getElementById('chg');
      c.textContent = t.chg24h == null ? '—' : (t.chg24h >= 0 ? '+' : '') + (t.chg24h * 100).toFixed(1) + '% 24h';
      c.className = 'chg ' + (t.chg24h == null ? 'dim' : t.chg24h >= 0 ? 'up' : 'down');
    }).catch(function () {});
  }
  setInterval(tick, 30000);
})();
</script></body></html>`;
}

/** The snippet a creator copies. Kept to one line so it survives any CMS. */
export const embedSnippet = (mint, base, { theme = 'dark', ref = null, width = 340, height = 230 } = {}) =>
  `<iframe src="${base}/embed/${mint}?theme=${theme}${ref ? `&r=${ref}` : ''}" width="${width}" height="${height}" `
  + `style="border:0;border-radius:14px;overflow:hidden" loading="lazy" title="REX Chain token card"></iframe>`;
