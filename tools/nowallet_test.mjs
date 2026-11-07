// The no-wallet path, which on a phone is a different problem from the one it used to solve.
//
// ⛔ A LINK TO phantom.app ON A PHONE SENDS SOMEBODY TO THE APP STORE AND LEAVES THEM THERE. After
// the install they are still in Safari, where there is still no wallet, and the site has no way to
// reach the one they just installed. Elio asked for "people with no wallet fam" and that was most
// of them. The deep link reopens the CURRENT page inside the wallet's own browser instead.
//
//   node tools/nowallet_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

console.log('── the deep links are built from the page you are actually on');
{
  const line = src.split('\n').find((l) => l.includes('phantom.app/ul/browse'));
  ok(!!line, 'a Phantom universal browse link exists');
  ok(line.includes('encodeURIComponent(u)'), 'with the target URL encoded — an unencoded query string would truncate it at the first &');
  const sol = src.split('\n').find((l) => l.includes('solflare.com/ul/v1/browse'));
  ok(!!sol, 'and a Solflare one');
}

console.log('\n── it is the CURRENT page, not the home page');
{
  ok(/const here = \(\) => location\.href/.test(src), 'the target is location.href');
  ok(src.includes('f(here())'), 'and that is what the buttons are built from, so a deep link lands back on the coin they were looking at');
}

console.log('\n── a phone is detected, including an iPad pretending to be a Mac');
{
  const line = src.split('\n').find((l) => l.startsWith('const isPhone'));
  ok(/iPhone|Android/.test(line), 'the usual agents are matched');
  ok(/maxTouchPoints/.test(line), 'and a touch Macintosh — which is how iPadOS reports itself, and would otherwise get the desktop extension links');
}

console.log('\n── desktop still gets install links, and the demo stays behind SIM');
{
  ok(src.includes('No Solana wallet detected'), 'the desktop copy is unchanged');
  ok(/WALLET_GET\b/.test(src) && src.includes('backpack.app/download'), 'with all three extensions offered');
  ok(src.includes("S.sim ? '<button class=\"btn\" id=\"demoW\">"), 'the paper-funds demo is still only offered in sim');
}

console.log('\n── every link is externally safe');
{
  // The hrefs are interpolated, so count the URL constants the modal is built from rather than
  // looking for literal domains inside href="" — which found nothing and said so, correctly.
  const urls = [...src.matchAll(/https:\/\/(?:phantom|solflare|backpack)[^'"`\s)]*/g)].map((m) => m[0]);
  ok(urls.length >= 5, `${urls.length} wallet URLs (2 deep links + 3 downloads)`);
  const external = src.split('\n').filter((l) => /target="_blank"/.test(l) && /(phantom|solflare|backpack)/.test(l));
  ok(external.every((l) => l.includes('rel="noopener"')), 'every target=_blank carries rel=noopener');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
