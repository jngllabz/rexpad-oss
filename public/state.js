// Shared state, API, WebSocket bus and wallet sign-in.
export const S = { me: null, gate: null, chain: null, privyAppId: null, privyClientId: null, token: localStorage.getItem('forge_token') || null, quotes: [], stats: null, nextEpochAt: 0, epochMs: 3600000, sim: false, online: 0, page: null };
const listeners = new Map();
export const bus = {
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  emit(type, data) { for (const fn of listeners.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } for (const fn of listeners.get('*') || []) { try { fn(type, data); } catch (e) { console.error(e); } } },
};
export async function api(path, body, method) {
  const h = { 'content-type': 'application/json' }; if (S.token) h.authorization = 'Bearer ' + S.token;
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const quoteOf = (sym) => S.quotes.find((q) => q.symbol === sym) || { symbol: sym, usd: 0, color: '#999' };
export const usdOf = (sym) => quoteOf(sym).usd || 0;

// ---------- websocket
let ws, wsTimer, subMint = null, wsGen = 0;
export function connectWs() {
  clearTimeout(wsTimer);
  if (ws) { const old = ws; ws = null; old.onclose = null; old.onmessage = null; try { old.close(); } catch {} } // one socket, ever
  const gen = ++wsGen;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // The session token used to go in the URL, which wrote it into the server's access log, any proxy
  // in front of it, and the browser's own history. It goes over the socket instead, once it is open.
  const sock = new WebSocket(`${proto}://${location.host}/ws`); ws = sock;
  sock.onopen = () => {
    if (gen !== wsGen) return;
    S.live = true;
    if (S.token) sock.send(JSON.stringify({ type: 'auth', token: S.token }));
    if (subMint) sock.send(JSON.stringify({ type: 'sub', mint: subMint }));
    bus.emit('ws', 'open');
  };
  sock.onmessage = (e) => { if (gen !== wsGen) return; let m; try { m = JSON.parse(e.data); } catch { return; } if (m.type === 'hello') { S.nextEpochAt = m.nextEpochAt; S.epochMs = m.epochMs; S.online = m.online; } if (m.type === 'epoch') S.nextEpochAt = m.nextEpochAt; if (m.type === 'stats') { S.stats = m.stats; S.online = m.online; S.nextEpochAt = m.stats.nextEpochAt; } bus.emit(m.type, m); };
  sock.onclose = () => { if (gen !== wsGen) return; S.live = false; wsTimer = setTimeout(connectWs, 1500 + Math.random() * 1500); bus.emit('ws', 'closed'); };
}
export function subscribe(mint) { subMint = mint; if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'sub', mint })); }

// ---------- wallet (Phantom / Backpack / Solflare via window.solana, or a Privy embedded wallet)
//
// ⛔ ONE SEAM, AND EVERY OTHER PATH IN THE APP GOES THROUGH IT. A Privy embedded wallet is a Solana
// keypair that can sign a message, which is the only thing this app ever asks a wallet to be — so
// it arrives here as something shaped exactly like `window.solana` and nothing downstream learns it
// exists. The alternative, threading an `isPrivy` flag through auth, trading, signing and the wallet
// menu, is how a codebase ends up with two half-working ways to be logged in.
//
// An injected wallet still wins when one is present: somebody who has Phantom open meant to use it.
let privyMod = null;
export const privyActive = () => !!privyMod?.active?.();
const provider = () => (privyMod?.active?.() ? privyMod.provider() : null)
  || window.phantom?.solana || window.solana || window.backpack || null;

/** Load the Privy adapter, but only on a deployment that has an app id. */
export async function privy() {
  if (!S.privyAppId) throw new Error('Privy is not enabled on this deployment');
  if (!privyMod) privyMod = await import('/privy.js');
  await privyMod.ready(S.privyAppId, S.privyClientId || null);
  return privyMod;
}

/**
 * Sign in with an email address.
 *
 * ⛔ THE SECOND HALF IS THE SAME SIGN-IN EVERYONE ELSE GETS. Once Privy hands back a wallet, this
 * calls the ordinary `connectWallet()` — same nonce, same signature, same session. There is no
 * Privy-specific auth on the server and there must not be: the server's job is to check that a
 * public key signed a nonce, and it does not care where the key lives.
 */
export async function privyLogin(email, code) {
  const m = await privy();
  await m.loginWithCode(email, code);
  return connectWallet();
}
/**
 * Wait a moment for a wallet extension to inject itself before declaring there isn't one.
 *
 * ⛔ "I HAVE PHANTOM AND IT SAYS NO WALLET DETECTED" IS USUALLY A RACE. The extension sets
 * window.phantom.solana from its own content script, and a click that lands in the gap — a cold
 * tab, a slow profile, a browser still waking the extension up — sees nothing and gets told to go
 * and install the thing it already has. Polling briefly costs nothing when the wallet is already
 * there (the first check returns it) and rescues the case where it is a few hundred milliseconds
 * behind.
 */
async function waitForProvider(ms = 1500) {
  const t0 = Date.now();
  for (;;) {
    const p = provider();
    if (p) return p;
    if (Date.now() - t0 >= ms) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function connectWallet({ silent = false } = {}) {
  const p = provider() || await waitForProvider();
  if (!p) { bus.emit('nowallet'); return null; }
  try {
    const r = await p.connect(); const wallet = (r?.publicKey || p.publicKey).toString();
    const { nonce, message } = await api('/api/auth/nonce', { wallet });
    const sig = await p.signMessage(new TextEncoder().encode(message), 'utf8');
    const bytes = sig.signature || sig; const b58 = (await import('/bs58.js')).encode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const v = await api('/api/auth/verify', { wallet, nonce, signature: b58 });
    S.token = v.token; localStorage.setItem('forge_token', v.token);
    await loadState(); connectWs();
    bus.emit('toast', { kind: 'ok', text: silent ? `Switched to ${S.me.name}` : `Signed in as ${S.me.name}` });
    bus.emit('auth', S.me); return S.me;
  } catch (e) { bus.emit('toast', { kind: 'err', text: e.message || 'Sign-in cancelled' }); return null; }
}

/**
 * Follow the wallet when it changes account, instead of making the user do it.
 *
 * ⛔ A STALE SESSION IS NOT A COSMETIC PROBLEM. Every transaction this site builds is built FOR a
 * particular public key, and the extension signs with whatever account it happens to be on — so a
 * session still pointing at the old account produces a transaction the wallet refuses with 4100,
 * "account not authorized", which says nothing about what went wrong. The site used to detect the
 * mismatch at signing time and tell the person to sign out and back in; detecting it was right and
 * handing it back to them was not.
 *
 * ⛔ THE OLD SESSION IS DROPPED FIRST, BEFORE anything is re-authorised. If the re-auth is declined
 * or fails, being signed out is correct — what must never happen is a page that goes on showing the
 * previous account's balances and building transactions for it while the wallet is somewhere else.
 *
 * One signature is unavoidable: a session is proof that this browser controls that key, and the new
 * key has not proved anything yet. One prompt is still the whole cost, where it used to be a manual
 * sign-out, a manual sign-in and the same prompt at the end of it.
 */
let switching = null;
export async function switchWallet() {
  if (switching) return switching;                  // one re-auth at a time, however many events fire
  switching = (async () => {
    const was = S.me?.wallet || null;
    S.token = null; S.me = null;
    try { localStorage.removeItem('forge_token'); } catch {}
    bus.emit('auth', null);
    const me = await connectWallet({ silent: true });
    if (!me && was) bus.emit('toast', { kind: 'err', text: 'Your wallet changed account, so you have been signed out.' });
    return me;
  })();
  try { return await switching; } finally { switching = null; }
}

/**
 * The extension's accountChanged event, where there is one.
 *
 * Phantom, Solflare and Backpack all emit it; support is uneven enough that `signer()` ALSO checks
 * the key before every signature, which is the backstop for a wallet that stays quiet. This is the
 * proactive half: the header, balances and buy box follow the switch straight away rather than at
 * the moment somebody tries to trade.
 */
export function watchWallet() {
  const p = provider();
  if (!p?.on) return;
  p.on('accountChanged', (pk) => {
    const key = pk?.toString?.() || null;
    // No key means disconnected in the extension — the matching action here is to sign out, not to
    // pop a signature prompt at somebody who has just locked their wallet.
    if (!key) { if (S.me) signOut(); return; }
    if (key === S.me?.wallet) return;               // reconnected to the same account; nothing to do
    switchWallet();
  });
  p.on('disconnect', () => { if (S.me) signOut(); });
}
export async function demoWallet() {
  try { const v = await api('/api/auth/demo', {}); S.token = v.token; localStorage.setItem('forge_token', v.token); await loadState(); connectWs(); bus.emit('toast', { kind: 'ok', text: `Demo wallet ready — ${S.me.name} (paper funds)` }); bus.emit('auth', S.me); return S.me; }
  catch (e) { bus.emit('toast', { kind: 'err', text: e.message }); return null; }
}
export async function signOut() { try { await api('/api/auth/logout', {}); } catch {} S.token = null; S.me = null; localStorage.removeItem('forge_token'); try { provider()?.disconnect?.(); } catch {} bus.emit('auth', null); connectWs(); }
/**
 * Bring a Privy wallet back after a reload.
 *
 * Without this, somebody who signed in with an email is signed out by refreshing the page — the
 * server session survives in localStorage, but `provider()` has nothing to offer it the moment
 * anything needs a signature. The flag is local and cheap to check; the restore is best-effort and
 * must never block the page, so a failure here is silent and they simply sign in again.
 */
export async function restorePrivy() {
  if (!S.privyAppId) return false;
  // ⛔ CHECK THE FLAG BEFORE IMPORTING, NOT AFTER. Reading it from inside the module means fetching
  // the module to find out it is not needed — on every page load, for every visitor who has never
  // touched Privy, which is nearly all of them.
  try { if (localStorage.getItem('rex_privy') !== '1') return false; } catch { return false; }
  try {
    const m = await import('/privy.js');
    if (!m.remembered()) return false;
    privyMod = m;
    await m.ready(S.privyAppId, S.privyClientId || null);
    return m.active();
  } catch { privyMod = null; return false; }
}

export async function loadState() {
  const st = await api('/api/state');
  S.quotes = st.quotes; S.stats = st.stats; S.me = st.me; S.sim = st.sim; S.online = st.online; S.gate = st.gate; S.chain = st.chain; S.swap = st.swap; S.nextEpochAt = st.stats.nextEpochAt; S.epochMs = st.stats.epochMs;
  S.privyAppId = st.privyAppId || null; S.privyClientId = st.privyClientId || null;
  S.king = st.king; S.fairOpens = st.fairOpens; S.feed = st.feed;
  // ⛔ THE LAUNCH VENUE. Dropping this one field is why no coin has ever launched on Meteora.
  // The server has reported venue:'dbc' since the mainnet switch, but loadState never copied it,
  // so `S.venue` was undefined, `S.venue === 'dbc'` was always false, and the launch button fell
  // through to the old-curve path every single time. BREX, MWAI and TEASURE are all on the old
  // curve for this reason — not, as first assumed, because somebody had a stale tab open. A field
  // the server sends and the client silently ignores fails exactly like a feature nobody built.
  S.venue = st.venue;
  // The second venue, and which pairs it can carry. ⛔ Its pair list comes from the SERVER's
  // LL_CONFIGS — Raydium creates those curve configs, not us — never from our quote table.
  S.launchlab = st.launchlab || { enabled: false, pairs: [] };
  // The fee module's ceilings and the open windows, straight from the server — the launch screen
  // reads these rather than carrying its own copy of the contract's limits.
  S.fees = st.fees; S.fairOpenChoices = st.fairOpenChoices; S.fairOpenDefault = st.fairOpenDefault;
  // Whether the AI dividend mode can actually run here, and the assets it may pick between. Both
  // come from the server: the mode needs a model configured, and the allowlist is derived from the
  // quotes registry — the only place a mint, its decimals and a live price are known together. The
  // launch form hides the card when `dividend` is false, so a box with no model never offers it.
  // ⛔ A DEFAULT, NOT A BARE ASSIGNMENT: an older server that does not send this must read as "no
  // feature", not as undefined, or the form's `S.ai.assets` lookups throw on the whole screen.
  S.ai = st.ai || { dividend: false, assets: [] };
  if (S.token && !S.me) { S.token = null; localStorage.removeItem('forge_token'); }
  // A platform referral link (?r=CODE anywhere on the site) binds this wallet to whoever shared it.
  // First touch and permanent, so calling it on every load is safe.
  try {
    const code = new URLSearchParams(location.search).get('r');
    if (code && S.me) await api('/api/ref/wallet', { code });
  } catch {}
  bus.emit('state', st); return st;
}
