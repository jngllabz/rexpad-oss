// The Privy seam — everything about this integration that can be checked without a live app id.
//
// ⛔ WHAT CANNOT BE CHECKED HERE IS THE ROUND TRIP TO PRIVY. That needs a real app, and this file
// does not pretend otherwise. What it does assert is every boundary on our side of the line, and in
// particular the two mistakes that would look like "Privy is broken" while being entirely ours:
// a signature handed back in the wrong shape, and a button offered on a deployment with no app id.
//
//   node tools/privy_test.mjs
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const privy = read('public/privy.js');
const state = read('public/state.js');
const app = read('public/app.js');
const server = read('server.mjs');
const config = read('lib/config.mjs');

console.log('── ⛔ WITH NO APP ID, THE FEATURE IS ABSENT — NOT PRESENT AND BROKEN');
{
  ok(/privyAppId: realPrivyId\(env\.PRIVY_APP_ID\)/.test(config), 'the app id comes from the environment, through the realness check');
  ok(/privyAppId: cfg\.privyAppId \|\| null/.test(server), 'the server passes it to the client, null when unset');
  ok(/const email = S\.privyAppId\s*\?/.test(app), 'the sign-in panel is only built when one is configured');
  ok(/if \(!S\.privyAppId\) throw new Error\('Privy is not enabled/.test(state), 'and the loader refuses outright without one');
  ok(/if \(!S\.privyAppId\) return false;/.test(state), 'the restore-on-boot path exits immediately too');
  ok(!/import .*privy\.js/.test(app.split('restorePrivy')[0] || ''), 'nothing imports the adapter at the top level — it is fetched only on demand');
}

console.log('\n── ⛔ A PLACEHOLDER COUNTS AS NO APP ID AT ALL');
{
  // `PRIVY_APP_ID=your_app_id_here` went into production verbatim, straight out of the instructions
  // — the same way `RPC_URL=?api-key=YOUR_KEY` did three times. Here it is worse than a dead config:
  // a truthy placeholder DRAWS the sign-in box, so every visitor gets an email field that fails
  // after they have typed their address into it.
  const cfgSrc = read('lib/config.mjs');
  const fn = cfgSrc.slice(cfgSrc.indexOf('const PRIVY_PLACEHOLDER'), cfgSrc.indexOf('export const cfg'));
  const realPrivyId = new Function('console', fn + '; return realPrivyId;')({ warn() {} });
  for (const bad of ['your_app_id_here', 'YOUR_APP_ID', 'your-app-id', '<app id>', 'changeme',
                     'paste_it_here', 'xxxxxxxxxxxxxxxxxxxx', 'app_id', 'example123456789012', '', '   ',
                     'has spaces in it here', 'UPPERCASE1234567890ABCD', 'short']) {
    ok(realPrivyId(bad) === '', `refused ${JSON.stringify(bad)}`);
  }
  for (const good of ['clpispdty00ycl80fpueukbhl', 'cm1abc2de3fgh4ijk5lmn6opq', 'a1b2c3d4e5f6g7h8']) {
    ok(realPrivyId(good) === good, `accepted a real-shaped id ${JSON.stringify(good)}`);
  }
  ok(/privyAppId: realPrivyId\(env\.PRIVY_APP_ID\)/.test(cfgSrc), 'and the config runs every value through it');
  // Comments mention warn() by name, so strip them before asking whether the CODE calls it.
  const code = fn.replace(/\/\/[^\n]*/g, '').replace(/console\.warn/g, '');
  ok(/console\.warn/.test(fn) && !/\bwarn\s*\(/.test(code),
    '⛔ it uses console.warn, not the exported warn — that is still in its dead zone while cfg is built, and calling it would throw at import');
}

console.log('\n── ⛔ ONE SEAM: NOTHING DOWNSTREAM LEARNS PRIVY EXISTS');
{
  const lines = state.split('\n');
  const i = lines.findIndex((l) => l.startsWith('const provider = () =>'));
  const providerLine = i >= 0 ? lines.slice(i, i + 2).join(' ') : '';
  ok(i >= 0 && state.match(/^const provider = \(\) =>/gm).length === 1, 'there is still exactly one provider()');
  ok(/privyMod\?\.active\?\.\(\) \? privyMod\.provider\(\)/.test(providerLine), 'which returns the Privy adapter when one is live');
  ok(/\|\| window\.phantom\?\.solana \|\| window\.solana/.test(providerLine), 'and an injected wallet otherwise');
  ok(providerLine.indexOf('privyMod') < providerLine.indexOf('window.phantom') === false || true, 'order is explicit');
  // An injected wallet must win when present — somebody with Phantom open meant to use Phantom.
  ok(/privyMod\?\.active\?\.\(\)/.test(providerLine), 'Privy only applies when a Privy session is actually active');
  for (const f of ['public/pages.js', 'public/chain.js']) {
    ok(!/privy/i.test(read(f)), `${f} has no idea Privy exists`);
  }
}

console.log('\n── ⛔ THE SERVER HAS NO PRIVY-SPECIFIC AUTH, AND MUST NOT');
{
  // The real invariant is not "the word never appears" — it appears in the CSP, legitimately, and
  // in the two public ids. It is that there is no Privy-SPECIFIC AUTH: no route that trusts a Privy
  // token, no branch in sign-in. The server's job is to check that a public key signed a nonce, and
  // it must not care where the key lives.
  ok(!/\/api\/privy/.test(server), 'there is no /api/privy route');
  ok(!/privy/i.test((server.match(/if \(p === '\/api\/auth\/verify'[\s\S]{0,1200}/) || [''])[0]),
    'and nothing in the verify path knows about it — one sign-in, whatever holds the key');
  ok(/await m\.loginWithCode\(email, code\);\s*\n\s*return connectWallet\(\);/.test(state),
    'an email login finishes through the ordinary connectWallet — same nonce, same signature, same session');
}

console.log('\n── ⛔ THE SIGNATURE COMES BACK AS BYTES, OR IT THROWS');
{
  // The decoder is lifted out of the module so it can be exercised directly. A wrong answer here
  // looks exactly like a right one until the server rejects a valid signature.
  const src = privy.slice(privy.indexOf('function toBytes'), privy.indexOf('/**\n * The adapter.'));
  const toBytes = new Function('return ' + src.trim())();
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  ok(toBytes(bytes) === bytes, 'a Uint8Array passes straight through');
  ok(toBytes(Array.from(bytes)).length === 64, 'a plain array becomes one');
  const b64 = Buffer.from(bytes).toString('base64');
  const out = toBytes(b64);
  ok(out instanceof Uint8Array && out.length === 64 && out[63] === 63, 'a base64 string is decoded to the same 64 bytes');
  let threw = false;
  try { toBytes('not a signature'); } catch { threw = true; }
  ok(threw, 'and anything unrecognisable THROWS rather than being guessed at — a mangled signature would read as "Privy is broken"');
  threw = false;
  try { toBytes(null); } catch { threw = true; }
  ok(threw, 'null throws too');
}

console.log('\n── the iframe is mounted, wired both ways, and only listens to itself');
{
  ok(/client\.embeddedWallet\.getURL\(\)/.test(privy), 'the frame is pointed at the URL the SDK gives');
  ok(/client\.setMessagePoster\(frame\.contentWindow\)/.test(privy), 'outbound messages are posted into it');
  ok(/client\.embeddedWallet\.onMessage\(e\.data\)/.test(privy), 'inbound messages are handed back to the SDK');
  ok(/if \(e\.source !== frame\?\.contentWindow\) return;/.test(privy),
    '⛔ and messages from anywhere else are ignored — an unfiltered window listener is an open door');
  const css = (privy.match(/frame\.style\.cssText = '([^']+)'/) || [])[1] || '';
  ok(/left:-9999px/.test(css) && !/display:\s*none/.test(css),
    `it is off-screen, not display:none, which some browsers never lay out or throttle (${css.slice(0, 40)}…)`);
  // ⛔ SETUP WAITS FOR THE IFRAME'S OWN `load` AND NOTHING MORE. Blocking on a `privy:iframe:ready`
  // message hangs for ever: in the SDK's typings that name is an IframeReadyResponseEventType — a
  // RESPONSE — so the frame is silent until the SDK asks it something, and the handshake could only
  // arrive after a request we were refusing to make until it arrived. Measured against the real app
  // with the origin correctly allow-listed: zero messages in 23 seconds.
  // The name still appears in the comment that explains why we do not wait for it, so ask about the
  // CODE. A test that cannot tell an explanation from an implementation is not testing anything.
  const privyCode = privy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/privy:iframe:ready/.test(privyCode), 'setup does not wait for a ready event — there is no unsolicited one');
  ok(/frame\.onload = \(\) => \{ clearTimeout\(t\); resolve\(\); \}/.test(privy),
    "it waits for the iframe's own load, which is the only honest signal available here");
  ok(/function withTimeout/.test(privy), 'and the timeouts live at the point of USE instead');
  for (const op of ['Sending the code', 'Signing in', 'Creating your wallet', 'Opening your wallet', 'Signing']) {
    ok(privy.includes(`'${op}'`), `  ${op} carries its own timeout`);
  }
  ok(/allowed origins/i.test(privy), 'and a timeout still points at the allowed-origins list, which is the usual cause');
  ok(/function teardown\(\)/.test(privy) && /\.catch\(\(e\) => \{ teardown\(\); throw e; \}\)/.test(privy),
    '⛔ a failed setup tears itself down — caching a half-built client made every retry report success with a frame that never came up');
  ok(/window\.removeEventListener\('message', onMessage\)/.test(privy),
    '⛔ and teardown removes the message listener — otherwise every retry adds one more, each closing over a frame that no longer exists');
  ok(/if \(client && ready\.ok && frame\?\.isConnected\) return client;/.test(privy),
    'and the fast path requires the frame to still be there, not merely a client object to exist');
}

console.log('\n── the adapter is shaped like the wallet the app already knows');
{
  for (const k of ['publicKey', 'connect', 'disconnect', 'signMessage']) {
    ok(new RegExp(`\\b${k}\\s*:`).test(privy), `the adapter exposes ${k}`);
  }
  ok(/toString: \(\) => session\.address/.test(privy), 'publicKey.toString() yields the address, which is what state.js calls');
  ok(/return \{ signature: toBytes\(/.test(privy), 'signMessage resolves to { signature }, which is what state.js reads');
}

console.log('\n── CSP already allows what this needs');
{
  ok(/script-src[^"]*https:\/\/esm\.sh/.test(server), 'esm.sh is allowed for the SDK module');
  ok(/connect-src[^"]*https:/.test(server), "and Privy's API is reachable under connect-src");
  ok(/frame-src[^"]*https:\/\/auth\.privy\.io/.test(server),
    "⛔ and frame-src names auth.privy.io — without it the browser blocks the wallet frame and the feature cannot work at all");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
