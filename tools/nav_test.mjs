// Can you get everywhere from the header, and does the header fit?
//
// These two questions are one test because they trade against each other. The nav was ten links
// wide, which overflowed a 1280px header and silently ate the Connect wallet button — and the
// obvious fix, cutting links, is the one that quietly orphans a page. So the thing worth asserting
// is BOTH at once: the chrome is short enough to fit, and every route is still reachable from it.
//
// Reachability counts the persistent chrome ONLY — the header, the footer and the mobile bar. A
// link that exists solely on the home page is not navigation, it is a feature of the home page: it
// is gone the moment somebody lands anywhere else, which is exactly the orphaning this prevents.
//
//   node tools/nav_test.mjs
import fs from 'node:fs';

// The state check needs a running server; default to the usual SIM port.
// ⛔ 8787, the same default as every other HTTP suite here. This used to default to 8799, so running
// the suites against one dev server left this one alone pointing at a dead port and failing with
// "/api/state answers ❌" — indistinguishable from a genuinely broken endpoint.
const B = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

const section = (re) => (re.exec(html) || [])[1] || '';
const navHtml = section(/<nav class="links">([\s\S]*?)<\/nav>/);
const footHtml = section(/<footer id="foot">([\s\S]*?)<\/footer>/);
const mnavHtml = section(/<nav id="mnav"[^>]*>([\s\S]*?)<\/nav>/);
const hrefs = (h) => [...h.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]);

const CHROME = new Set([...hrefs(navHtml), ...hrefs(footHtml), ...hrefs(mnavHtml)]);

// Every client route the app actually serves, read from the router rather than a list kept by hand
// — a list by hand is a list that goes stale the first time somebody adds a page.
// ⛔ AND ROUTES WRITTEN AS AN ALTERNATION COUNT TOO. This matched `[/^\/name$/,` only, so
// `[/^\/(?:brand|design|press)$/,` was invisible: the brand page was unlinked AND unchecked, and
// the suite reported green. A reachability test that cannot see a route is worse than none, because
// it is believed.
const ROUTES = [
  ...[...app.matchAll(/\[\/\^\\\/([a-z-]*)\$\/,/g)].map((m) => '/' + m[1]),
  ...[...app.matchAll(/\[\/\^\\\/\(\?:([a-z|-]+)\)\$\/,/g)].flatMap((m) => m[1].split('|').map((n) => '/' + n)),
];

console.log('\n── every page is reachable from the persistent chrome');
{
  // Routes that are deliberately not linked: they are reached by doing something, not by browsing.
  // ⛔ /earnings is INTERNAL — the protocol's own income, gated on the wallets the chain says get
  // paid. Linking it from the public footer would advertise a page almost every visitor is refused,
  // so it is reached by URL by the handful of people it is for. Being unlinked is the point here,
  // not an oversight, which is exactly why it has to be named rather than silently skipped.
  //
  // ⛔ /design and /press are ALIASES OF /brand, not pages. They exist because those are the two
  // things people type looking for a brand kit, and landing them somewhere beats "Nothing here to
  // eat". Linking all three would put the same page in the footer three times, so they are named
  // here for the same reason /earnings is: unlinked on purpose, said out loud.
  const BY_ACTION = new Set(['/me', '/welcome', '/create', '/earnings', '/design', '/press']);
  const browsable = ROUTES.filter((r) => !BY_ACTION.has(r));
  ok(browsable.length > 5, `router exposes ${browsable.length} browsable routes`);
  for (const r of browsable) {
    ok(CHROME.has(r), `${r} is linked from the header, footer or mobile bar`);
  }
  for (const r of BY_ACTION) {
    if (ROUTES.includes(r)) console.log(`   (${r} is reached by an action, not a link — not required)`);
  }
}

console.log('\n── the header is short enough to fit');
{
  const links = hrefs(navHtml);
  // Ten links is what overflowed 1280px. Five plus a conditional Swap is what fits with the search
  // box, the epoch chip, the language switch and BOTH actions still on screen.
  ok(links.length <= 6, `${links.length} links in the header (ceiling 6 — ten overflowed 1280px)`);
  ok(links.includes('/'), 'the market is in the header');
  ok(links.includes('/leaderboard'), 'the leaderboard is in the header — it is the hub the cut links fall back to');
}

console.log('\n── the two actions can never be cut again');
{
  const css = fs.readFileSync('public/styles.css', 'utf8');
  ok(/#nav \.right\{[^}]*flex:0 0 auto/.test(css), '.right is flex:0 0 auto — it never shrinks');
  ok(/#nav \.links\{[^}]*overflow-x:auto/.test(css), '.links scrolls rather than pushing the actions off');
  // The INVARIANT is the shrink factor, not its exact value. Flexbox splits a squeeze in proportion
  // to factor x basis, so a search with the same factor as the links gives up the same share and a
  // nav link loses its tail — which is what happened at 1280 with a factor of 1, and still happened
  // at 20. Anything comfortably above 1 expresses "search gives first"; the test should not pin the
  // number, only the property that makes the priority real.
  const shrink = /#nav \.search\{[^}]*flex:0 (\d+) /.exec(css);
  ok(shrink && Number(shrink[1]) >= 10,
    `.search gives up space before the links do (shrink factor ${shrink ? shrink[1] : 'MISSING'}, needs >= 10)`);
  ok(/#nav \.search\{[^}]*min-width:1\d\d/.test(css), 'and it can shrink to a small minimum');
  // Below these widths the header cannot fit everything, so two things step aside in order. Both
  // are decoration: the countdown is repeated on the rewards page, and the mark alone still
  // identifies the site. Neither is a destination, which is why they go before a link does.
  ok(/@media \(max-width:12\d\dpx\)\{ ?#nav \.epoch-chip\{display:none\}/.test(css),
    'the payout countdown steps aside before a nav link is clipped');
  ok(/@media \(max-width:11\d\dpx\)\{ ?#nav \.brand \.word\{display:none\}/.test(css),
    'and the wordmark steps aside after it');
}

console.log('\n── the links that left the header did not leave the site');
{
  for (const r of ['/build', '/growth', '/points', '/rewards', '/learn']) {
    ok(hrefs(footHtml).includes(r) || hrefs(mnavHtml).includes(r),
      `${r} moved to the footer or the mobile bar rather than disappearing`);
  }
}

console.log('\n── the client reads every field the server sends it');
{
  // ⛔ THE BUG THIS EXISTS FOR: /api/state reported venue:'dbc' for a full day and state.js never
  // copied it onto S, so the launch button's `S.venue === 'dbc'` branch was dead and every coin
  // went to the old curve. A dropped field fails exactly like a feature nobody wrote — silently,
  // and with the UI insisting everything is configured correctly.
  const state = await fetch(B + '/api/state').then((r) => r.json()).catch(() => null);
  const src = fs.readFileSync('public/state.js', 'utf8');
  const consumed = new Set([...src.matchAll(/st\.(\w+)/g)].map((m) => m[1]));
  const dropped = Object.keys(state || {}).filter((k) => !consumed.has(k));
  ok(state !== null, '/api/state answers');
  ok(dropped.length === 0, `every field /api/state sends is read by the client${dropped.length ? ' — DROPPED: ' + dropped.join(', ') : ''}`);
  ok(consumed.has('venue'), 'the launch venue specifically is read (it gates which chain path a launch takes)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
