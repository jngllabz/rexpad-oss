/**
 * Privy — an embedded wallet for people who have not got one.
 *
 * Elio, 7 Oct: "There needs to be a way to get to your wallet… or add wallet infra like fomo called
 * privy. Let's add privy. For people with no wallet fam."
 *
 * ⛔ THE WHOLE DESIGN IS THAT NOTHING ELSE IN THE APP LEARNS ABOUT PRIVY.
 *
 * REX Chain signs people in by having a Solana keypair sign a nonce, and every page, every trade
 * and every launch goes through the one `provider()` in state.js that returns an injected wallet.
 * A Privy embedded wallet is also a Solana keypair that can sign a message — so the right shape for
 * it is not a second auth path through the codebase, it is an ADAPTER that presents exactly what
 * `window.solana` presents: `publicKey`, `connect()`, `signMessage()`, `disconnect()`.
 *
 * Do that, and the rest of the site cannot tell the difference and does not have to. One file, one
 * seam, and no second way for anything to be logged in. The alternative — threading an `isPrivy`
 * flag through auth, trading, signing and the wallet menu — is how two half-working login systems
 * happen.
 *
 * ⛔ AND IT IS INERT UNLESS AN APP ID IS CONFIGURED. The module is only imported when the server
 * reports one, so with no `PRIVY_APP_ID` set this file is never fetched, the SDK is never loaded,
 * and no button offering it is ever drawn. That matters because the live sign-in round trip cannot
 * be exercised without a real app: everything below is written against the published type
 * definitions of @privy-io/js-sdk-core 0.78.1 and tested at its seams, but the first end-to-end
 * login has to be done against a real app id. Failing loudly beats failing silently, so every step
 * throws with its own message rather than leaving a dead button.
 */
// ⛔ THIS IS A BIG DEPENDENCY AND IT IS LOADED LATE ON PURPOSE. The core SDK supports Ethereum as
// well as Solana, so importing it pulls viem, libphonenumber and ~200 modules besides. None of that
// is on the critical path: this file is only fetched when a deployment has an app id AND somebody
// chooses email sign-in, so a visitor with Phantom never pays a byte of it. Pinned to an exact
// version — a floating range here would silently change what runs in people's browsers.
const SDK = 'https://esm.sh/@privy-io/js-sdk-core@0.78.1';

let mod = null;          // the loaded SDK module
let client = null;       // the Privy client
let frame = null;        // the secure iframe the embedded wallet runs its crypto in
let session = null;      // { address, provider } once a wallet is live
let onMessage = null;    // the window listener, kept so teardown can remove it

/** Load the SDK once. Lazy on purpose: nobody who signs in with Phantom should pay for this. */
async function load() {
  if (!mod) mod = await import(/* @vite-ignore */ SDK);
  return mod;
}

/**
 * Stand up the client and its iframe.
 *
 * ⛔ THE IFRAME IS NOT OPTIONAL AND IS NOT COSMETIC. Privy's embedded wallet keeps its key material
 * in a document on Privy's own origin, which is the entire security argument for it — our page can
 * ask for a signature and can never read the key. The SDK talks to that document over postMessage,
 * so without the iframe mounted and the message bus wired in both directions, every wallet call
 * hangs for ever rather than failing.
 */
export async function ready(appId, clientId = null) {
  if (client && ready.ok && frame?.isConnected) return client;
  if (!appId) throw new Error('Privy is not configured on this deployment');
  // ⛔ A FAILED SETUP MUST NOT LEAVE A HALF-BUILT CLIENT BEHIND. The first version assigned `client`
  // before waiting for the frame, so once setup had failed once, every later call hit the
  // `if (client) return client` line and reported success — with a frame that had never come up.
  // The failure then resurfaced as a hang on the first wallet operation, nowhere near the cause.
  // Found against a real app id, which is exactly the class of thing a real app id finds.
  teardown();
  const m = await load();
  const Privy = m.default || m.Privy;
  if (!Privy) throw new Error('the Privy SDK did not load');

  client = new Privy({ appId, clientId: clientId || undefined, storage: new m.LocalStorage() });
  await client.initialize();

  frame = document.createElement('iframe');
  frame.src = client.embeddedWallet.getURL();
  frame.title = 'Privy embedded wallet';
  // Off-screen rather than display:none — a hidden iframe is throttled or never laid out in some
  // browsers, and a secure context that never runs is a wallet call that never answers.
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px';

  // ⛔ THERE IS NO UNSOLICITED READY EVENT, AND WAITING FOR ONE HANGS FOR EVER.
  //
  // The first version blocked here until the frame posted `privy:iframe:ready`, on the assumption
  // that a secure context announces itself. It does not: in this SDK's own typings that name is an
  // `IframeReadyResponseEventType` — a RESPONSE — and the frame is silent until the SDK asks it
  // something. So the handshake I was waiting for could only have arrived after a request I was
  // refusing to make until it arrived. Captured against the real app: zero messages in 23 seconds,
  // with the origin correctly allow-listed.
  //
  // The honest signal that the document exists is the iframe's own `load`. Readiness beyond that is
  // not knowable here and does not need to be: the first real wallet operation drives the handshake
  // and carries its own timeout, so a broken frame fails at the point of use with a real error
  // instead of turning sign-in into a twenty-second stall before anyone has typed anything.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the Privy wallet frame did not load')), 20_000);
    frame.onload = () => { clearTimeout(t); resolve(); };
    frame.onerror = () => { clearTimeout(t); reject(new Error('the Privy wallet frame failed to load')); };
    document.body.appendChild(frame);
  }).catch((e) => { teardown(); throw e; });

  // ⛔ BOTH DIRECTIONS, AND ONLY FROM THE FRAME WE MOUNTED. An unfiltered message listener on
  // window is an open door: any page we embed, and any opener, can post into it.
  onMessage = (e) => {
    if (e.source !== frame?.contentWindow) return;
    try { client.embeddedWallet.onMessage(e.data); } catch { /* not ours to interpret */ }
  };
  window.addEventListener('message', onMessage);
  client.setMessagePoster(frame.contentWindow);

  ready.ok = true;
  return client;
}

/** Drop everything, so a retry is a real retry rather than a cached failure. */
function teardown() {
  ready.ok = false;
  // ⛔ REMOVE THE LISTENER TOO. Without this, every retry adds another one, each closing over a
  // frame that no longer exists — a slow leak that also hands stale frames' messages to the SDK.
  if (onMessage) { window.removeEventListener('message', onMessage); onMessage = null; }
  try { frame?.remove(); } catch { /* already gone */ }
  frame = null;
  client = null;
}

/**
 * Wrap a wallet call so a frame that never answers fails in seconds with something a person can act
 * on. This is where the timeout belongs — at the point of use, where we know what was being asked.
 */
function withTimeout(promise, what, ms = 45_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `${what} timed out — the Privy wallet did not respond. If this persists, check that `
      + `${location.origin} is in the app's allowed origins at dashboard.privy.io.`,
    )), ms)),
  ]);
}

/** Send the one-time code. */
export async function sendCode(email) {
  if (!client) throw new Error('Privy is not ready');
  const e = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) throw new Error('That does not look like an email address');
  await withTimeout(client.auth.email.sendCode(e), 'Sending the code', 20_000);
  return true;
}

/**
 * Finish the login, make sure there is a Solana wallet, and build the provider for it.
 *
 * A returning user already has the wallet; a new one does not, and `createSolana` is what makes the
 * difference between "signed in" and "signed in with somewhere to hold a coin".
 */
export async function loginWithCode(email, code) {
  if (!client) throw new Error('Privy is not ready');
  const m = await load();
  let res = await withTimeout(client.auth.email.loginWithCode(String(email).trim(), String(code).trim()), 'Signing in', 30_000);
  let user = res?.user || res;

  let account = m.getUserEmbeddedSolanaWallet(user);
  if (!account) {
    const made = await withTimeout(client.embeddedWallet.createSolana(), 'Creating your wallet');
    user = made?.user || made;
    account = m.getUserEmbeddedSolanaWallet(user);
  }
  if (!account?.address) throw new Error('Privy signed you in but no Solana wallet came back');

  const ent = m.getEntropyDetailsFromUser(user, account);
  if (!ent) throw new Error('Privy did not return the details needed to open your wallet');
  const provider = await withTimeout(client.embeddedWallet.getSolanaProvider(account, ent.entropyId, ent.entropyIdVerifier), 'Opening your wallet');

  session = { address: account.address, provider };
  try { localStorage.setItem('rex_privy', '1'); } catch { /* private mode */ }
  return session.address;
}

/** Is a Privy wallet live in this tab? */
export const active = () => !!session;
/** Did this browser last sign in with Privy? Used to decide whether to restore it on load. */
export const remembered = () => { try { return localStorage.getItem('rex_privy') === '1'; } catch { return false; } };

export async function logout() {
  try { await client?.auth?.logout(); } catch { /* the local session is what matters */ }
  session = null;
  try { localStorage.removeItem('rex_privy'); } catch { /* private mode */ }
}

/**
 * ⛔ THE SIGNATURE HAS TO COME BACK AS BYTES, BECAUSE THAT IS WHAT THE REST OF THE APP EXPECTS.
 *
 * state.js does `sig.signature || sig` and base58-encodes the result, so a string handed through
 * unchanged would be encoded as the bytes of its own text and the server would reject a signature
 * that was actually valid — a failure that reads like "Privy is broken" and is not. The SDK's own
 * notes say the iframe serialises the Uint8Array to a string over the message bus and the SDK
 * deserialises it back, so both shapes are possible depending on version; both are handled, and an
 * unrecognised one throws rather than being guessed at.
 */
function toBytes(sig) {
  if (sig instanceof Uint8Array) return sig;
  if (Array.isArray(sig)) return Uint8Array.from(sig);
  if (sig && typeof sig === 'object' && typeof sig.length === 'number') return Uint8Array.from(sig);
  if (typeof sig === 'string') {
    // A 64-byte Solana signature is 88 base64 characters or 86-88 base58 ones; base64 is what a
    // message bus uses, so it is tried first and only a clean round trip is accepted.
    try {
      const bin = atob(sig.replace(/-/g, '+').replace(/_/g, '/'));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      if (out.length === 64) return out;
    } catch { /* not base64 — fall through */ }
  }
  throw new Error('Privy returned a signature in a shape this app does not recognise');
}

/**
 * The adapter. This is the only thing the rest of the app ever sees.
 *
 * Deliberately shaped like `window.solana` down to the details state.js actually touches:
 * `connect()` resolving to something with a `publicKey`, a `publicKey` on the object itself, and a
 * `signMessage` resolving to `{ signature }`.
 */
export function provider() {
  if (!session) return null;
  const pk = { toString: () => session.address, toBase58: () => session.address };
  return {
    isPrivy: true,
    publicKey: pk,
    isConnected: true,
    connect: async () => ({ publicKey: pk }),
    disconnect: async () => { await logout(); },
    signMessage: async (bytes) => {
      const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      const r = await withTimeout(session.provider.request({ method: 'signMessage', params: { message: text } }), 'Signing');
      return { signature: toBytes(r?.signature ?? r) };
    },
    signTransaction: async (txn) => {
      const r = await session.provider.request({ method: 'signTransaction', params: { transaction: txn } });
      return r?.signedTransaction ?? r;
    },
  };
}

/** Test seam: the byte decoding is the part with a wrong answer that looks like a right one. */
export const __toBytes = toBytes;
