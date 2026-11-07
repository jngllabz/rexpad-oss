// A coin's website and socials — who can set them, and where they actually show up.
//
// ⛔ WHAT WAS REPORTED: "on rex pad, each coin page doesn't have the social links or website."
// Both halves of that were true at once, and they have different causes:
//
//   1. THEY WERE RENDERED IN ONE PLACE — the sixth tab, behind Trades/Holders/Community/Chat/
//      Payouts. 33 of the 60 live coins had a link stored and not one of them looked like it did.
//   2. AND 27 HAD NONE AT ALL, permanently: the three fields existed on the launch form and
//      nowhere else, so a coin that launched without them could never be given them.
//
// ⛔ AND THEN: "also add the socials on the coin cards on the board." Same complaint one level out
//    — a board where you cannot see which coin has a site is a board you have to open 60 tabs from.
//    That half has a trap of its own, held by the third section below: a coin card WAS a single
//    <a href="/t/...">, and an <a> inside an <a> is a PARSE ERROR, not nesting.
//
// So the fix is a renderer AND a writer, and this suite holds the writer's two traps:
//
//   ⛔ AN EDIT HAS TO LAND IN BOTH TABLES. indexer.reconcile() re-upserts every on-chain launch
//      from `token_meta` on a short timer and takes website/twitter/telegram from it. An edit
//      written only to `tokens` saves, survives a reload, and is reverted within a tick.
//   ⛔ BUT token_meta IS UPDATED, NEVER INSERTED. That upsert reads `meta.name || mint.slice(0,6)`,
//      so a row invented here with a null name would rename the coin to six characters of its mint.
//
//   SIM=1 PORT=8787 DATA_DIR=/tmp/rexqa node server.mjs
//   node tools/token_links_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const B = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const up = await fetch(B + '/api/health').then((r) => r.ok).catch(() => false);
if (!up) { console.log(`Cannot reach ${B} — is the server running?`); process.exit(1); }

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const post = async (p, body, tok) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (p, tok) => {
  const r = await fetch(B + p, { headers: tok ? { authorization: 'Bearer ' + tok } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const demo = async () => (await post('/api/auth/demo', {})).body;

console.log('\n── a creator can put links on a coin that launched without them');
const me = await demo();
const launch = await post('/api/tokens', { name: 'Link Test', symbol: 'LKT', image: PNG, quote: 'SOL', holderBps: 100, fairOpenSecs: 0 }, me.token);
const mint = launch.body?.token?.mint;
ok(!!mint, `launched a coin to work on (${launch.status})`);
if (mint) {
  const before = (await get(`/api/tokens/${mint}`)).body.token;
  ok(!before.website && !before.twitter && !before.telegram, 'it starts with no links, like most live coins');

  // What a creator actually types. A bare host, a padded paste, and one that is not a link at all.
  const r = await post('/api/creator/links', { mint, website: '  rex.fun/home  ', twitter: 'x.com/tryrexfun', telegram: 'javascript:alert(1)' }, me.token);
  ok(r.status === 200, `the save is accepted (${r.status})`);
  const t = (await get(`/api/tokens/${mint}`)).body.token;
  ok(t.website === 'https://rex.fun/home', `a bare host is stored as a real URL (${t.website})`);
  ok(t.twitter === 'https://x.com/tryrexfun', `and so is a pasted handle link (${t.twitter})`);
  // ⛔ The field is called "telegram", not "trusted". cleanLink is http(s)-only and this is the one
  // input on the page that a stranger controls and every visitor clicks.
  ok(t.telegram === null, `a javascript: URL is refused rather than stored (${JSON.stringify(t.telegram)})`);

  console.log('\n── and it reaches the metadata every wallet and scanner reads');
  // ⛔ /api/meta/<mint>.json is written into the mint's metadata at creation and can never be
  // changed, so this route is the ONLY way a link ever reaches a wallet. It reads the same row.
  const meta = (await get(`/api/meta/${mint}.json`)).body;
  ok(meta?.extensions?.website === 'https://rex.fun/home', 'the metadata JSON carries the website');
  ok(meta?.extensions?.twitter === 'https://x.com/tryrexfun', 'and the twitter link');
  ok(!('telegram' in (meta?.extensions || {})), 'and omits the one that was refused, rather than emitting null');

  console.log('\n── an empty field takes a link off, because a typo has to be fixable');
  // One save a second per wallet. Spelled out because the first version of this test fired the
  // clear immediately, got a 429 it never read, and reported "a blank does not clear" — a test
  // that ignores the status of its own write can only ever measure the write before it.
  await new Promise((r) => setTimeout(r, 1100));
  const cleared = await post('/api/creator/links', { mint, website: '', twitter: 'https://x.com/tryrexfun', telegram: '' }, me.token);
  ok(cleared.status === 200, `the second save is accepted (${cleared.status})`);
  const t2 = (await get(`/api/tokens/${mint}`)).body.token;
  ok(t2.website === null, 'a blank clears the website instead of quietly keeping the old value');
  ok(t2.twitter === 'https://x.com/tryrexfun', 'and the field left alone is untouched');

  console.log('\n── nobody else can touch them');
  const other = await demo();
  const theft = await post('/api/creator/links', { mint, website: 'https://not-yours.example' }, other.token);
  ok(theft.status === 400 || theft.status === 403, `another wallet is refused (${theft.status})`);
  ok(/launched this coin/i.test(theft.body?.error || ''), `and told why (${theft.body?.error || ''})`);
  const anon = await post('/api/creator/links', { mint, website: 'https://not-yours.example' });
  ok(anon.status === 401 || anon.status === 403, `so is an unauthenticated caller (${anon.status})`);
  const t3 = (await get(`/api/tokens/${mint}`)).body.token;
  ok(t3.twitter === 'https://x.com/tryrexfun' && !t3.website, 'and the coin still has what its creator left on it');

  console.log('\n── the creator dashboard shows what each coin currently has');
  const dash = (await get(`/api/creator?wallet=${me.wallet}`, me.token)).body;
  const row = (dash.coins || []).find((c) => c.mint === mint);
  ok(!!row, 'the coin is on the dashboard');
  ok(row && 'website' in row && 'twitter' in row && 'telegram' in row,
    'and its row carries the links, so the editor opens on what is really stored');
  ok(row?.twitter === 'https://x.com/tryrexfun', 'with the saved value, not the typed one');
}

console.log('\n── an edit lands in BOTH tables, or the indexer reverts it');
{
  // Its own database: this half is about rows, not routes.
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-links-'));
  process.env.DB_NAME = 'links.sqlite';
  const { db } = await import('../lib/db.mjs');
  const E = await import('../lib/engine.mjs');
  const IX = await import('../lib/indexer.mjs');
  const bs58 = (await import('bs58')).default;
  const crypto = await import('node:crypto');
  const addr = () => bs58.encode(crypto.randomBytes(32));

  const creator = addr();
  E.ensureWallet(creator);
  const t = E.createToken(creator, { name: 'Both Tables', symbol: 'BOTH', quote: 'SOL', holderBps: 100, fairOpenSecs: 0 });
  IX.saveMeta({ mint: t.mint, name: 'Both Tables', symbol: 'BOTH', creator });

  // ⛔ 'https://rex.fun' comes back as 'https://rex.fun/' — cleanLink returns URL.href, which
  // normalises an empty path to a slash. Worth pinning: it is the difference between a link that
  // compares equal to what was typed and one that does not.
  E.setLinks(t.mint, creator, { website: 'https://rex.fun', twitter: '', telegram: 't.me/tryrexfun' });
  const row = db.prepare('SELECT website, telegram FROM tokens WHERE mint=?').get(t.mint);
  const meta = db.prepare('SELECT website, telegram FROM token_meta WHERE mint=?').get(t.mint);
  ok(row.website === 'https://rex.fun/', 'the tokens row has it — what the coin page reads');
  ok(meta?.website === 'https://rex.fun/',
    'and token_meta has it — what reconcile() re-upserts the tokens row FROM, every tick');
  ok(row.telegram === 'https://t.me/tryrexfun' && meta?.telegram === 'https://t.me/tryrexfun', 'both tables, both fields');

  // ⛔ A coin with no token_meta row must not gain one here: that upsert reads
  // `meta.name || mint.slice(0, 6)`, so a row with a null name renames the coin.
  const paper = E.createToken(creator, { name: 'No Meta', symbol: 'NOMETA', quote: 'SOL', holderBps: 100, fairOpenSecs: 0 });
  E.setLinks(paper.mint, creator, { website: 'https://rex.fun' });
  ok(!db.prepare('SELECT mint FROM token_meta WHERE mint=?').get(paper.mint),
    'a coin with no token_meta row does not get one invented for it');
  ok(db.prepare('SELECT website FROM tokens WHERE mint=?').get(paper.mint).website === 'https://rex.fun/',
    'and its links still save');

  let threw = null;
  try { E.setLinks(t.mint, addr(), { website: 'https://not-yours.example' }); } catch (e) { threw = e.message; }
  ok(/launched this coin/i.test(threw || ''), `the engine refuses a stranger too, not only the route (${threw})`);
  ok(db.prepare('SELECT website FROM tokens WHERE mint=?').get(t.mint).website === 'https://rex.fun/', 'and nothing moved');
}

console.log('\n── and the board card shows them, out of the REAL tokenCard');
{
  // ⛔ THE POINT OF IMPORTING public/ui.js RATHER THAN ASSERTING ON ITS TEXT. The bug this guards
  // is a PARSE error — an <a> inside an <a> makes the parser close the outer one, so .kpi and the
  // curve bar would be emitted as siblings of the card and laid out as their own grid items. A grep
  // for `<a class="card"` would pass on markup that is still broken, and fail on markup that is
  // fine but spelled differently. So: render the real function and count the depth.
  //
  // It is browser code, so three files are copied with their absolute specifiers made relative.
  // Nothing else is stubbed, because nothing else runs at import time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-card-'));
  for (const f of ['ui.js', 'state.js', 'icons.js', 'fx.js']) {
    if (!fs.existsSync(`public/${f}`)) continue;
    fs.writeFileSync(path.join(dir, f), fs.readFileSync(`public/${f}`, 'utf8').replace(/from '\/([\w.-]+)'/g, "from './$1'"));
  }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const UI = await import(path.join(dir, 'ui.js'));

  const coin = (over = {}) => ({
    mint: 'So11111111111111111111111111111111111111112', name: 'Board Coin', symbol: 'BRD',
    creator: 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUu', quote: 'SOL', status: 'live',
    createdAt: Date.now() - 60_000, holders: 12, progress: 0.3, raised: 3, raiseTarget: 10,
    price: 1e-6, mcapUsd: 1234, chg5m: 1.2, yieldPaid: 0, liquidity: 0, taxBps: 100,
    fees: { holderBps: 100 }, spark: [1, 2, 3], ...over,
  });

  // Depth, not a substring: every <a ...> opens one and every </a> closes one.
  const maxAnchorDepth = (html) => {
    let d = 0, max = 0;
    for (const m of html.matchAll(/<a\b[^>]*>|<\/a>/g)) { d += m[0] === '</a>' ? -1 : 1; max = Math.max(max, d); }
    return max;
  };

  const linked = UI.tokenCard(coin({ website: 'https://rex.fun/', twitter: 'https://x.com/tryrexfun', telegram: 'https://t.me/tryrexfun' }));
  ok(maxAnchorDepth(linked) === 1, `a card with all three links never nests an anchor (max depth ${maxAnchorDepth(linked)})`);
  ok((linked.match(/data-link/g) || []).length === 1, 'exactly one anchor routes in-app — the card\'s own');
  ok(/<a class="cardlink" href="\/t\/So111[^"]*" data-link/.test(linked), 'and it still points at the coin, over the whole card');
  ok(/aria-label="Board Coin \$BRD"/.test(linked), 'the stretched link is labelled, since it has no text of its own');
  for (const u of ['https://rex.fun/', 'https://x.com/tryrexfun', 'https://t.me/tryrexfun']) ok(linked.includes(`href="${u}"`), `the card carries ${u}`);
  ok((linked.match(/rel="noopener nofollow"/g) || []).length === 3, 'all three are noopener AND nofollow, like the coin page');
  ok((linked.match(/target="_blank"/g) || []).length === 3, 'and all three open away from the board');
  // app.js skips its router on target=_blank, so a social click must not also navigate to the coin.
  ok(!/<a class="soc"[^>]*data-link/.test(linked), 'a social link is not also an in-app route');
  ok(/aria-label="Twitter"/.test(linked) && /aria-label="Telegram"/.test(linked) && /aria-label="Website"/.test(linked),
    'each icon says what it is, having no text');

  const bare = UI.tokenCard(coin());
  ok(!bare.includes('class="socs"'), 'a coin with no links gets no empty row — 27 of 60 are that coin');
  ok(maxAnchorDepth(bare) === 1 && (bare.match(/data-link/g) || []).length === 1, 'and it is still exactly one link');

  const one = UI.tokenCard(coin({ twitter: 'https://x.com/only' }));
  ok(one.includes('class="socs"') && (one.match(/class="soc"/g) || []).length === 1, 'one link renders one icon, not three');

  // ⛔ A quoted href is the one place a stored link reaches markup, and cleanLink only guarantees
  // the scheme. h() is what stops the rest.
  const nasty = UI.tokenCard(coin({ website: 'https://x.test/"><img src=x onerror=alert(1)>' }));
  ok(!nasty.includes('<img src=x'), 'a quote-breaking URL is escaped rather than closing the attribute');

  console.log('\n── and the board LIST carries them, which is what the card renders from');
  // The card can only show what /api/tokens hands it. publicToken carries these today; a list view
  // trimmed for payload size is exactly how it would stop.
  const list = (await get('/api/tokens?limit=120')).body?.tokens || [];
  ok(list.length > 0, `the board returns coins (${list.length})`);
  ok(list.every((t) => 'website' in t && 'twitter' in t && 'telegram' in t), 'every row on it carries all three fields');
  if (mint) {
    const row = list.find((t) => t.mint === mint);
    ok(!!row, 'including the coin this run edited');
    ok(row?.twitter === 'https://x.com/tryrexfun', `with the saved link, not a stale copy (${row?.twitter})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed, 0 skipped`);
process.exit(fail ? 1 : 0);
