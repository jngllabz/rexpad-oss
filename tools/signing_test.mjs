// Is the wallet we ask to sign the same wallet we built the transaction for?
//
// ⛔ THE BUG THIS EXISTS FOR. Every transaction on this site is BUILT SERVER-SIDE FOR
// `S.me.wallet` — the account this browser signed into the site with — and then handed to whatever
// account the wallet extension happens to be on. Switch account in Phantom, lock and unlock it, or
// revoke the site, and those are two different keys. The wallet then refuses with
//
//     "The requested method and/or account has not been authorized by the user."   (code 4100)
//
// which names neither account and reads like the site is broken. It was hit on the $REX swap box,
// and FIVE separate places signed the same way — including the launch flow, where it would have
// struck on the second of two prompts, after a coin's config transaction had already landed.
//
// `isConnected` is not sufficient: it can report true while the authorisation for the CURRENT
// account is stale, so `if (!isConnected) connect()` skips the one call that would fix it. The
// public key is what must be trusted, not the flag.
//
//   node tools/signing_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const chain = fs.readFileSync('public/chain.js', 'utf8');
const pages = fs.readFileSync('public/pages.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

console.log('\n── one place decides whether the wallet may sign');
{
  ok(/export async function signer\(\)/.test(chain), 'chain.js exports signer()');
  ok(/export async function signTx\(/.test(chain), 'and signTx()');
  const fn = /export async function signer\(\)[\s\S]*?\n\}/.exec(chain)?.[0] || '';
  ok(/key !== S\.me\.wallet/.test(fn), 'it compares the wallet\'s CURRENT account against the session');
  // ⛔ THIS ASSERTION USED TO READ "the refusal says what to actually do about it", and checked for
  // "Switch account in your wallet". That WAS the right design — it is better than a bare 4100 —
  // and it has been deliberately superseded: a mismatch is now followed automatically rather than
  // handed back to somebody in the middle of a trade. The test moves with the decision.
  ok(/switchWallet\(\)/.test(fn), 'a mismatch re-authorises for the new account instead of refusing');
  ok(!/Switch account in your wallet/.test(fn), 'and no longer asks the person to do it by hand');
  // A DECLINED switch must still stop, and still name the account — that part has not changed.
  ok(/sk\(key\)/.test(fn), 'a declined switch names the account the wallet is actually on');
  ok(/nothing has been sent/.test(fn), 'and says plainly that nothing was sent');
  ok(/!p\.isConnected \|\| !key/.test(fn),
    'a missing public key forces a connect even when isConnected claims true');
  ok(/declined the wallet connection/.test(fn), 'a refused connection is reported as refused, not as a crash');
}

console.log('\n── a stale authorisation is recovered once, not forever');
{
  const fn = /export async function signTx\([\s\S]*?\n\}/.exec(chain)?.[0] || '';
  ok(/4100/.test(fn) && /not been authorized/i.test(fn), 'signTx recognises the stale-authorisation failure');
  ok(/await p\.connect\(\);\n    return p\.signTransaction\(tx\)/.test(fn), 'it reconnects and retries exactly once');
  ok(/if \(!stale\) throw e/.test(fn), 'and never swallows a different error');
}

console.log('\n── nothing signs on its own any more');
{
  for (const [name, src] of [['pages.js', pages], ['app.js', app]]) {
    const raw = [...src.matchAll(/\b(?:p|pr)\.signTransaction\(/g)].length;
    ok(raw === 0, `${name} has no raw wallet.signTransaction call (${raw} found)`);
    const guard = [...src.matchAll(/if \(!(?:p|pr)\.isConnected\) await (?:p|pr)\.connect\(\)/g)].length;
    ok(guard === 0, `${name} no longer trusts isConnected alone (${guard} found)`);
  }
  ok(/import \* as CHAIN from '\/chain\.js'/.test(app), 'app.js imports the shared signer');
  // The launch is two prompts; the check has to happen BEFORE the first one.
  const launch = /async function launchOnMeteora[\s\S]*?\n  \}/.exec(pages)?.[0] || '';
  ok(/await CHAIN\.signer\(\)/.test(launch), 'the launch verifies the account before asking for any signature');
  ok(/CHAIN\.signTx\(tx\)/.test(launch), 'and signs each step through the shared path');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
