// Does Spanish mode translate what it should, and can it ever rewrite something a user typed?
//
// The site renders by writing innerHTML from template literals, so translation walks the rendered
// text nodes and swaps EXACT WHOLE-NODE matches. That rule is the whole safety story: a ticker, a
// wallet or a coin name someone chose cannot be hit, because it is not a key in the dictionary.
//
// ⛔ ANCHORED PATTERNS WEAKEN THAT RULE, WHICH IS WHY THEY ARE TESTED HERE. Strings with a figure
// baked into them — "18.79M REX raised" is a different string every minute — can never match
// whole-node, so a small set of patterns translates around the dynamic part. The first draft of one
// was /^Pays (.+)$/, and it rewrote "Pays attention to detail": the exact accident the whole-node
// rule exists to prevent, reintroduced by the thing meant to work around it. Every pattern must be
// anchored at BOTH ends with its capture constrained to figures, tickers and punctuation.
//
//   node tools/i18n_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const src = fs.readFileSync('public/i18n.js', 'utf8');
const block = src.match(/const NUM = [\s\S]*?\n\};/);
if (!block) { console.log('❌ could not find the PATTERNS block in public/i18n.js'); process.exit(1); }
const PATTERNS = eval(block[0].replace('const NUM', 'var NUM').replace('const PATTERNS', 'var PATTERNS') + '\nPATTERNS');
const tr = (t) => { for (const [re, rep] of PATTERNS.es) if (re.test(t)) return t.replace(re, rep); return t; };

console.log('\n── every pattern is anchored at both ends');
for (const [re] of PATTERNS.es) {
  const s = re.source;
  ok(s.startsWith('^') && s.endsWith('$'), `anchored: ${s.slice(0, 54)}`);
}

console.log('\n── strings with a figure or ticker inside them do get translated');
for (const t of ['18.79M REX raised', '93.90M REX to go', 'Buy $BITE', 'Sell $BITE', 'Share $BITE',
                 'created 3h ago by', 'Balance: — REX', '0 payouts · 0 epochs', 'Pays 3%',
                 'Graduates at 112.69M REX ($20.3K) · then migrates price-continuously to an AMM with burned LP']) {
  const o = tr(t);
  ok(o !== t, `"${t.slice(0, 40)}" -> "${o.slice(0, 40)}"`);
}

console.log('\n── and anything a user could have written is left alone');
// Each of these is a near-miss for one of the patterns on purpose.
for (const t of ['Buy the dip now', 'raised by the community', 'Balance', 'Pays attention to detail',
                 'Share your thesis', 'created a new thing', 'Sell everything']) {
  ok(tr(t) === t, `left alone: "${t}"`);
}

console.log('\n── the dictionary covers the coin page');
{
  const dict = src.slice(src.indexOf('es: {'), src.indexOf('const NUM'));
  for (const k of ['You pay', 'You receive', 'Price impact', 'Liquidity', 'Trades', 'Bonding curve',
                   'Payouts', 'Connect wallet to trade', 'Pool this epoch', 'Slippage']) {
    ok(dict.includes(`'${k}'`), `has a translation for "${k}"`);
  }
}

// ⛔ A COVERAGE FLOOR, because "everything should be Spanish" is not something a dictionary can be
// eyeballed for. ES mode shipped with ~40 keys against a site of ~490 visible strings, so whole
// pages — the pairs board, points, referrals, the API page — rendered English headers under Spanish
// chrome and nothing failed. This counts the rendered text nodes and fails if too many have no
// translation. The permitted remainder is proper nouns: tickers, brands, URLs.
console.log('\n── Spanish covers the rendered text, not just the chrome');
{
  const PROPER = new Set(['$REX', 'REX', 'REX Chain', 'SOL', 'DexScreener', 'DexScreener ↗', 'Telegram',
    'Pump', 'Stonk', 'META', 'MOLT', 'ALTS', 'CHAIN', 'Molten Cat', 'Shrimp Fund', 'Whale Club',
    'Mcap', 'Mint', 'Swap', 'pts', 'tx', 'sum()', 'https://', 'https://t.me/…', 'https://x.com/…',
    '𝕏 @tryrexfun', 'rex.fun', 'rewards.rex.fun',
    // A file path is not prose. These are the font files the brand page hands out by name, and
    // translating a path would break the thing it points at.
    '/brand/fonts/Inter-Regular.ttf', '/brand/fonts/Inter-Bold.ttf']);
  // Strip ${...} so what is left is the static text of each node; a node that was part dynamic
  // cannot whole-node match and is not counted against coverage.
  const stripInterp = (s) => {
    let out = '', i = 0;
    while (i < s.length) {
      if (s[i] === '$' && s[i + 1] === '{') { let d = 0; i++; while (i < s.length) { if (s[i] === '{') d++; else if (s[i] === '}') { d--; if (!d) { i++; break; } } i++; } out += '\u0000'; }
      else out += s[i++];
    }
    return out;
  };
  const CODE = /[{}`;]|=>|\|\||&&|\s=\s|\.\w+\(|\breturn\b|\bconst\b|\bnull\b|\bfalse\b|\btrue\b/;
  const dictSrc = src.slice(src.indexOf('es: {'), src.indexOf('const NUM'));
  // ⛔ BOTH QUOTE STYLES. This matched single-quoted keys only, so every entry whose ENGLISH
  // contains an apostrophe — which has to be written "Don't …" in double quotes — was invisible to
  // the coverage count. Four brand-page strings were translated and still reported as missing,
  // which reads as a coverage regression and is really the checker not seeing its own dictionary.
  const have = new Set([
    ...[...dictSrc.matchAll(/'((?:[^'\\]|\\.)*)'\s*:/g)].map((m) => m[1].replace(/\\'/g, "'")),
    ...[...dictSrc.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1].replace(/\\"/g, '"')),
  ]);
  const nodes = new Set();
  for (const f of ['public/pages.js', 'public/ui.js', 'public/app.js']) {
    let body; try { body = stripInterp(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const m of body.matchAll(/>([^<>]{2,240})</g)) {
      const t = m[1].trim().replace(/\s+/g, ' ');
      if (t.includes('\u0000') || !/[A-Za-z]{2}/.test(t) || CODE.test(t)) continue;
      if (/^[,.:;)\]]/.test(t) || /[([,]$/.test(t)) continue;
      nodes.add(t);
    }
  }
  const missing = [...nodes].filter((t) => !have.has(t) && !PROPER.has(t));
  const pct = Math.round(((nodes.size - missing.length) / nodes.size) * 100);
  ok(pct >= 97, `${pct}% of ${nodes.size} rendered strings have a Spanish translation (floor 97%)`);
  if (missing.length > 4) console.log('   untranslated:', missing.slice(0, 12).map((t) => JSON.stringify(t)).join(', '));
  // The board the owner reported: its headers are built from WIN_LABEL and render UPPERCASE.
  for (const k of ['24H volume', '7D volume', '30D volume', 'ALL volume', 'Rewards paid', 'Realized APY', 'Search pairs…', 'Pairs'])
    ok(have.has(k), `the pairs board header "${k}" is translated`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
