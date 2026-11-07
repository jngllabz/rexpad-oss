// ⛔ "I ALREADY HAVE PHANTOM AND IT SAYS NO WALLET DETECTED."
//
// Three "Connect wallet" buttons raised the no-wallet dialog DIRECTLY instead of calling
// connectWallet(). They announced the failure instead of trying: pressing one showed "No Solana
// wallet detected" whether or not a wallet was installed. The header's button had always been
// right; these three were the outliers.
//
// The second half is a race. The extension sets window.phantom.solana from its own content
// script, and a click that lands in the gap — a cold tab, a slow profile, a browser still waking
// the extension up — sees nothing and tells somebody to install what they already have.
//
//   node tools/connect_wallet_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const pages = fs.readFileSync(new URL('../public/pages.js', import.meta.url), 'utf8');
const state = fs.readFileSync(new URL('../public/state.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

console.log('── ⛔ NO BUTTON ANNOUNCES "NO WALLET" WITHOUT LOOKING FIRST');
{
  ok(!/bus\.emit\('nowallet'\)/.test(pages),
    'not one call site in pages.js raises the dialog directly');
  for (const id of ['cwal', 'ewal', 'admSignIn']) {
    const i = pages.indexOf(`#${id}`);
    ok(i > 0 && /connectWallet\(\)/.test(pages.slice(i, i + 260)), `the #${id} button calls connectWallet()`);
  }
  // The dialog itself is still raised — but only from the one place that has checked.
  ok(/if \(!p\) \{ bus\.emit\('nowallet'\); return null; \}/.test(state),
    '⛔ connectWallet is the only thing that decides there is no wallet');
  ok(/wb\.onclick = connectWallet/.test(app), 'and the header button goes through the same path');
}

console.log('\n── it waits for the extension to inject before giving up');
{
  ok(/async function waitForProvider/.test(state), 'there is a wait');
  const fn = /async function waitForProvider[\s\S]*?\n\}/.exec(state)?.[0] || '';
  ok(/const p = provider\(\);\s*\n\s*if \(p\) return p;/.test(fn),
    '⛔ which checks FIRST — an already-present wallet costs nothing');
  ok(/Date\.now\(\) - t0 >= ms\) return null/.test(fn), 'and gives up rather than hanging for ever');
  ok(/provider\(\) \|\| await waitForProvider\(\)/.test(state), 'connectWallet uses it');
}

console.log('\n── ⛔ EVERY WALLET THE PRODUCT CLAIMS TO SUPPORT IS LOOKED FOR');
{
  // The dialog offers Phantom, Solflare and Backpack. Detection has to cover what it offers, and
  // Phantom's own namespace comes first — another extension can take window.solana.
  const det = /const provider = \(\) =>[\s\S]*?;\n/.exec(state)?.[0] || '';
  ok(/window\.phantom\?\.solana/.test(det), 'window.phantom.solana');
  ok(/window\.solana/.test(det), 'window.solana');
  ok(/window\.backpack/.test(det), 'window.backpack');
  ok(det.indexOf('window.phantom') < det.indexOf('window.solana'),
    '⛔ Phantom\'s own namespace is checked before the shared one another extension can occupy');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
