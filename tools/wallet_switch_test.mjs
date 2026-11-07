// Switching account in the wallet should switch the site, not stop the person.
//
// ⛔ WHY A STALE SESSION IS DANGEROUS AND NOT MERELY UNTIDY. Every transaction this site builds is
// built FOR a particular public key, and the extension signs with whichever account it is currently
// on. A session still pointing at the previous account therefore produces a transaction the wallet
// rejects with 4100 — "account not authorized" — which tells the person nothing about what is
// wrong. `isConnected` does not catch it either: it can report true while the authorisation for the
// current account is stale.
//
// The site already detected the mismatch. What it did next was throw "switch account in your
// wallet, or sign out and back in" at somebody in the middle of a trade: right about the problem,
// useless about the answer.
//
//   node tools/wallet_switch_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const state = fs.readFileSync('public/state.js', 'utf8');
const chain = fs.readFileSync('public/chain.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
// ⛔ STRIP COMMENTS BEFORE LOOKING FOR USER-FACING TEXT. The comments explaining why the old
// instruction was removed CONTAIN the old instruction, so a naive search finds the documentation and
// reports the thing as still present. tools/mobile_test.mjs learned this the same way: a test that
// fails on its own prose teaches you to stop trusting it.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const chainCode = strip(chain), stateCode = strip(state);

console.log('── nobody is told to sign out and back in');
{
  ok(!/sign out and back in/i.test(chainCode), 'the old instruction is gone from the signing path');
  ok(!/sign out and back in/i.test(stateCode), 'and from the session code');
  const signer = chain.slice(chain.indexOf('export async function signer'), chain.indexOf('export async function signTx'));
  ok(/switchWallet\(\)/.test(signer), 'a mismatch at signing time re-authorises instead of throwing');
  // It still has to FAIL if the person declines — silently continuing would sign with the wrong key.
  ok(/declined/i.test(signer) && /nothing has been sent/i.test(signer),
    'and a declined switch still stops the transaction, in words');
}

console.log('\n── the stale session is dropped BEFORE anything is re-authorised');
{
  const sw = state.slice(state.indexOf('export async function switchWallet'), state.indexOf('export function watchWallet'));
  ok(sw.length > 0, 'switchWallet exists');
  const clears = sw.indexOf('S.me = null');
  const reauth = sw.indexOf('connectWallet(');
  ok(clears > 0 && reauth > clears,
    'the old session is cleared first, so a declined or failed re-auth leaves nobody signed in as the wrong account');
  ok(/localStorage.removeItem\('forge_token'\)/.test(sw), 'and the stored token goes with it');
  // ⛔ Several events can fire for one switch; re-entering would mean two signature prompts.
  ok(/if \(switching\) return switching/.test(sw), 'concurrent switches collapse into one re-auth');
}

console.log('\n── the site follows the wallet proactively, not only at signing time');
{
  ok(/accountChanged/.test(state), 'accountChanged is listened for');
  ok(/watchWallet\(\)/.test(app), 'and the watcher is registered at boot');
  const watch = state.slice(state.indexOf('export function watchWallet'));
  // A null key means the extension disconnected or locked. Popping a signature prompt at somebody
  // who has just locked their wallet is the wrong answer; signing out is the right one.
  ok(/if \(!key\)/.test(watch) && /signOut\(\)/.test(watch), 'a disconnect signs out rather than prompting');
  ok(/key === S\.me\?\.wallet/.test(watch), 'and reconnecting to the SAME account does nothing at all');
}

console.log('\n── the backstop still exists for wallets that stay quiet');
{
  // accountChanged support is uneven, so the key is still checked before every signature.
  const signer = chain.slice(chain.indexOf('export async function signer'), chain.indexOf('export async function signTx'));
  ok(/key !== S\.me\.wallet/.test(signer), 'signer() still compares the live key with the session');
  ok(/publicKey/.test(signer) && !/isConnected\s*\)\s*return/.test(signer),
    'and trusts the public key rather than isConnected, which can be true while stale');
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
