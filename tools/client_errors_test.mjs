// What a person is actually shown when something throws, and whether we copied what we said we did.
//
// Two bug families, both found by exercising the real pages rather than reading them:
//
//   ⛔ FIVE CLIPBOARD SITES CLAIMED SUCCESS UNCONDITIONALLY. `navigator.clipboard.writeText` rejects
//   whenever the document is not focused, the origin is insecure, or permission is refused — and
//   every one of those showed "Copied" while the clipboard still held its previous contents. On a
//   launchpad the most-copied string is a contract address, and a confident "Copied" followed by
//   pasting the PREVIOUS one into a wallet is how somebody buys the wrong token.
//
//   ⛔ AND A JAVASCRIPT FAULT WAS BEING PRINTED TO TRADERS. Measured on /points against a malformed
//   response: "Cannot read properties of null (reading 'me')", rendered into the page.
//
//   node tools/client_errors_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const ui = read('public/ui.js'), pages = read('public/pages.js'), app = read('public/app.js');

console.log('── ⛔ NOBODY CLAIMS A COPY HAPPENED WITHOUT CHECKING');
{
  for (const [f, src] of [['pages.js', pages], ['app.js', app]]) {
    ok(!/navigator\.clipboard/.test(src), `${f} does not touch the clipboard API directly any more`);
  }
  ok(/export async function copyText/.test(ui), 'there is one helper');
  ok(/execCommand\('copy'\)/.test(ui), 'with a legacy fallback for an insecure origin, where the modern API simply does not exist');
  ok(/return !!ok;/.test(ui), 'and it returns what actually happened');
  // every call site branches on the result
  const calls = [...pages.matchAll(/copyText\([^)]*\)/g), ...app.matchAll(/copyText\([^)]*\)/g)];
  ok(calls.length >= 7, `${calls.length} call sites`);
  const unchecked = [...pages.split('\n'), ...app.split('\n')]
    .filter((l) => /copyText\(/.test(l) && !/\.then\(|await copyText|=> copyText/.test(l));
  ok(unchecked.length === 0, `none of them ignore the result${unchecked.length ? ' — ' + unchecked[0].trim().slice(0, 70) : ''}`);
}

console.log('\n── ⛔ A JAVASCRIPT FAULT IS NEVER SHOWN TO A TRADER');
{
  const fn = ui.slice(ui.indexOf('export function niceErr'), ui.indexOf('export async function copyText'));
  // Lifted out of the shipped file so this tests what runs. console.error is stubbed because a
  // handled fault logging to stderr is correct behaviour, not test output.
  const f = new Function('console', fn.replace('export function niceErr', 'return function niceErr'))({ error() {} });
  ok(f(new Error('Amount must be a positive number')) === 'Amount must be a positive number',
    'a server message — written for people — passes through untouched');
  ok(f(new Error('You already called $SYB. You can call it again in 6h.')).includes('6h'), 'including the specific ones');
  ok(f(new TypeError("Cannot read properties of null (reading 'me')")) === 'Something went wrong there',
    'a TypeError does NOT reach the user');
  ok(f(new RangeError('Division by zero')) === 'Something went wrong there', 'nor a RangeError');
  ok(f(new ReferenceError('x is not defined')) === 'Something went wrong there', 'nor a ReferenceError');
  // ⛔ ORDERING: "Failed to fetch" IS a TypeError, so the network branch has to come first or the
  // one diagnosis a user can act on is replaced by a shrug.
  ok(f(new TypeError('Failed to fetch')) === 'Could not reach the server — check your connection',
    '⛔ a dropped connection says so, even though it arrives as a TypeError');
  ok(f(new TypeError('Load failed')) === 'Could not reach the server — check your connection', "and Safari's wording for the same thing");
  ok(f(new Error('')) === 'Something went wrong there', 'an empty message falls back');
  ok(f(null) === 'Something went wrong there', 'so does nothing at all');
  ok(f(undefined, 'Could not send the code') === 'Could not send the code', 'and a caller can give its own fallback');
}

console.log('\n── every user-facing error goes through it');
{
  for (const [f, src] of [['pages.js', pages], ['app.js', app]]) {
    const raw = src.split('\n').filter((l) => /\be(?:rr)?\.message\b/.test(l));
    ok(raw.length === 0, `${f} has no raw .message reaching the UI${raw.length ? ' — ' + raw[0].trim().slice(0, 60) : ''}`);
  }
}

console.log('\n── ⛔ A PAGE THAT THROWS DOES NOT LEAVE A BLANK SCREEN');
{
  ok(/try \{ teardown = await fn\(m\); \}/.test(app), 'the router awaits each page inside a try');
  ok(/This page did not load/.test(app), 'and renders something when it throws');
  ok(/id="retryPage"/.test(app), 'with a retry, because it is usually a hiccup');
  ok(/api\('\/api\/ref\/top'\)\.catch/.test(pages) && /api\('\/api\/milestones'\)\.catch/.test(pages),
    "and /growth's legs each catch, so one dead endpoint does not take out five panels that had no need of it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
