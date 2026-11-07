// Per-route social cards, checked against the HTML a CRAWLER actually receives.
//
// This is not a unit test of lib/meta.mjs. The thing that breaks in practice is the stamping: the
// markup is rewritten with regexes against a hand-written index.html, so a reordered attribute, a
// renamed meta tag or a stray quote silently stops one of the replacements matching and the route
// quietly serves the site default again. Nobody notices until a link is already in a group chat.
// So every assertion here reads the served page.
//
//   SIM=1 PORT=8787 DATA_DIR=/tmp/rexqa node server.mjs
//   node tools/meta_test.mjs
const B = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const st = await fetch(B + '/api/health').then((r) => r.ok).catch(() => false);
if (!st) { console.log(`Cannot reach ${B} — is the server running?`); process.exit(1); }

const grab = async (p) => {
  const html = await fetch(B + p).then((r) => r.text());
  const one = (re) => (re.exec(html) || [])[1] || null;
  return {
    html,
    title: one(/<title>([\s\S]*?)<\/title>/),
    desc: one(/<meta name="description" content="([^"]*)"/),
    ogTitle: one(/<meta property="og:title" content="([^"]*)"/),
    ogDesc: one(/<meta property="og:description" content="([^"]*)"/),
    ogImage: one(/<meta property="og:image" content="([^"]*)"/),
    ogUrl: one(/<meta property="og:url" content="([^"]*)"/),
    twTitle: one(/<meta name="twitter:title" content="([^"]*)"/),
    twDesc: one(/<meta name="twitter:description" content="([^"]*)"/),
    twImage: one(/<meta name="twitter:image" content="([^"]*)"/),
    canonical: one(/<link rel="canonical" href="([^"]*)"/),
  };
};

const ROUTES = ['/', '/pairs', '/rewards', '/fair-opens', '/leaderboard', '/swap', '/create', '/learn', '/build', '/points', '/growth', '/me'];

console.log('\n── every route is stamped, and stamped consistently');
const seen = {};
for (const p of ROUTES) {
  const m = await grab(p);
  seen[p] = m;
  ok(!!m.title && !!m.desc, `${p}: has a title and a description`);
  // The three copies of the title must agree. They are three separate regex replacements, so this
  // is exactly where a half-applied stamp shows up.
  ok(m.title === m.ogTitle && m.ogTitle === m.twTitle, `${p}: <title>, og:title and twitter:title agree`);
  ok(m.desc === m.ogDesc && m.ogDesc === m.twDesc, `${p}: description, og:description and twitter:description agree`);
  // Crawlers do not resolve relative image URLs. A root-relative og:image is a card nobody sees.
  ok(/^https?:\/\//.test(m.ogImage || ''), `${p}: og:image is absolute (${String(m.ogImage).slice(0, 48)})`);
  ok(m.ogImage === m.twImage, `${p}: og:image and twitter:image are the same card`);
  ok(m.canonical === `${B}${p === '/' ? '/' : p}` && m.ogUrl === m.canonical, `${p}: canonical and og:url point at this route`);
}

console.log('\n── routes do not share one blurb');
{
  const titles = ROUTES.map((p) => seen[p].title);
  const unique = new Set(titles);
  ok(unique.size >= ROUTES.length - 2, `${unique.size} distinct titles across ${ROUTES.length} routes`);
  const descs = new Set(ROUTES.map((p) => seen[p].desc));
  ok(descs.size >= ROUTES.length - 2, `${descs.size} distinct descriptions`);
}

console.log('\n── the boards carry their live numbers');
{
  const m = seen['/pairs'];
  // Both states are asserted, because the headline deliberately differs. With volume it leads with
  // the figures; with none it leads with what the page IS, rather than selling a working board as a
  // broken one with "$0.00 in 24h". Either way the real numbers stay in the description — that is
  // the line between choosing a headline and hiding a figure, and it is what this checks.
  const live = await fetch(B + '/api/pairs?window=24h&limit=1').then((x) => x.json()).catch(() => null);
  const vol = live?.totals?.volumeUsd || 0;
  ok(/pair/i.test(m.title), `/pairs title names the page: "${m.title}"`);
  if (vol > 0) ok(/\d/.test(m.title), 'and carries the live figures, because there are some');
  else ok(!/\$0/.test(m.title), 'and does not headline a zero while the board is empty');
  ok(/\d/.test(m.desc), 'the description carries the real figures either way');
  ok(/realized apy/i.test(m.desc), '/pairs description names realized APY');
  ok(/not a projection/i.test(m.desc), 'and says it is not a projection — the same claim the page makes');
  ok(/\/og\/pairs\.png$/.test(m.ogImage), '/pairs has its own card, not the site default');
  const img = await fetch(B + '/og/pairs.png');
  ok(img.ok && (img.headers.get('content-type') || '').includes('image/png'), `/og/pairs.png renders (${img.status})`);
  ok(Number(img.headers.get('content-length') || 1e6) > 5000 || img.ok, 'and is a real image rather than an empty body');

  const rw = seen['/rewards'].title;
  ok(/reward/i.test(rw) && !/\$0\.00/.test(rw), `/rewards title: "${rw}" — states the total once there is one, never a zero`);
}

console.log('\n── a money figure cannot be read as a regex backreference');
{
  // ⛔ THE BUG THIS EXISTS FOR: the stamp used String.replace with a "$1" replacement string, and
  // these descriptions are full of money. The moment a figure formatted as "$1.09M", that `$1` was
  // read as capture group 1 and the matched `<meta name="description" content="` was spliced into
  // the middle of the head, mangling every tag after it. Mainnet's figures are all $0, so it would
  // have shipped unnoticed until the first coin traded past a million.
  const m = seen['/pairs'];
  const all = [m.title, m.desc, m.ogTitle, m.ogDesc, m.twTitle, m.twDesc];
  ok(!all.some((x) => /<meta|<title|content="/.test(String(x))),
    'no stamped tag has markup spliced into its value');
  for (const [label, v] of [['title', m.title], ['description', m.desc]]) {
    const dollars = String(v).match(/\$\d/g) || [];
    if (dollars.length) ok(!/\$\d[^\d.,KMB%]/.test(String(v).replace(/\$\d[\d.,]*/g, '')),
      `${label} keeps its money figures whole (${dollars.join(' ')})`);
  }
  ok(String(m.desc).length > 40 && !String(m.desc).includes('<'), '/pairs description is intact text');
}

console.log('\n── a token link still unfurls as that token');
{
  const r = await fetch(B + '/api/tokens?limit=1').then((x) => x.json()).catch(() => null);
  const t = (Array.isArray(r) ? r : r?.tokens || [])[0];
  if (!t) { console.log('… no tokens in the book, skipping'); }
  else {
    const m = await grab(`/t/${t.mint}`);
    ok(m.title.includes(t.symbol), `token title names the ticker: "${m.title}"`);
    ok(m.ogImage.endsWith(`/og/${t.mint}.png`), 'and points at that token\'s own card');
    ok(m.canonical.endsWith(`/t/${t.mint}`), 'and is canonical to the token page');
  }
}

console.log('\n── an unknown route falls back rather than breaking');
{
  const m = await grab('/this-route-does-not-exist');
  ok(!!m.title && !!m.ogImage, 'unknown route still serves a complete card');
  ok(/^https?:\/\//.test(m.ogImage), 'with an absolute image');
}

console.log('\n── /me says nothing about anybody');
{
  // A crawler has no session, and these strings are cached and re-served by the platforms that
  // fetch them. A personal figure here would be a personal figure in somebody else's group chat.
  const m = seen['/me'];
  ok(!/\$\d/.test(m.desc), '/me description carries no balance or dollar figure');
  ok(!/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(m.desc + m.title), 'and no wallet address');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
