// Wallet-signed on-chain actions. The server builds an unsigned transaction, Phantom signs it,
// and the server relays it — the site never sees a private key.
import { S, api, bus, switchWallet } from '/state.js';

export const on = () => !!S.chain;
const provider = () => window.phantom?.solana || window.solana || window.backpack || null;

/**
 * The wallet, connected, with the account it is ACTUALLY on checked against the session.
 *
 * ⛔ THE BUG THIS EXISTS FOR: every transaction here is BUILT SERVER-SIDE FOR `S.me.wallet` — the
 * account this browser signed into the site with — and then handed to whatever account the wallet
 * extension happens to be on. Switch account in Phantom, lock and unlock it, or revoke the site,
 * and those are two different keys. The wallet then refuses with
 *
 *     "The requested method and/or account has not been authorized by the user."  (code 4100)
 *
 * which names nothing and reads like the site is broken. It hit the $REX swap box, and it would
 * have hit a launch identically, because all of them signed the same way.
 *
 * `isConnected` is NOT sufficient on its own: it can report true while the authorisation for the
 * CURRENT account is stale, so `if (!isConnected) connect()` skips the one call that would fix it.
 * Connecting again is idempotent and cheap, so the public key is what gets trusted, not the flag.
 */
export async function signer() {
  const p = provider();
  if (!p) { bus.emit('nowallet'); throw new Error('No wallet'); }
  let key = p.publicKey?.toBase58?.() || null;
  if (!p.isConnected || !key) {
    try {
      const r = await p.connect();
      key = r?.publicKey?.toBase58?.() || p.publicKey?.toBase58?.() || null;
    } catch (e) {
      throw new Error(/reject|denied|cancel/i.test(e?.message || '') ? 'You declined the wallet connection.' : `Wallet would not connect: ${e?.message || e}`);
    }
  }
  if (!key) throw new Error('Your wallet did not return an account. Unlock it and try again.');
  const sk = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;
  if (S.me?.wallet && key !== S.me.wallet) {
    // ⛔ FOLLOW THE WALLET; DO NOT SEND THE PERSON AWAY TO DO IT BY HAND. This used to throw
    // "switch account in your wallet, or sign out and back in" — correct about the problem and
    // useless about the answer, in the middle of a trade they were halfway through. The mismatch
    // matters because the transaction is built FOR a key and the extension signs with whichever
    // account it is on, so a stale session produces a 4100 the wallet reports as "account not
    // authorized" and nobody can interpret.
    //
    // This is the BACKSTOP for a wallet that emits no accountChanged event; `watchWallet` handles
    // the ones that do. Re-authorising here costs one signature and leaves the person exactly where
    // they were, with the right account.
    await switchWallet();
    const now = provider()?.publicKey?.toBase58?.() || null;
    if (!S.me?.wallet || now !== S.me.wallet) {
      throw new Error(`Your wallet is on ${sk(key)} and signing in as that account was declined, so nothing has been sent.`);
    }
    return provider();
  }
  return p;
}

/**
 * Sign, recovering once from an authorisation that went stale between connecting and signing.
 * A single retry is the right number: if a fresh `connect()` does not fix it, retrying again only
 * puts a second popup in front of somebody who has already been told no.
 */
export async function signTx(tx) {
  const p = await signer();
  try { return await p.signTransaction(tx); }
  catch (e) {
    const stale = e?.code === 4100 || /not been authorized|unauthorized/i.test(e?.message || '');
    if (!stale) throw e;
    await p.connect();
    return p.signTransaction(tx);
  }
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (u8) => btoa(String.fromCharCode(...u8));

/** Build → sign → send. Returns the confirmed signature. */
export async function act(what, payload = {}, { onStage } = {}) {
  const p = provider();
  if (!p) { bus.emit('nowallet'); throw new Error('No wallet'); }
  if (!S.me) throw new Error('Sign in first');
  onStage?.('building');
  const built = await api(`/api/chain/build/${what}`, { wallet: S.me.wallet, ...payload });

  // Surface a failure before asking the user to sign anything.
  onStage?.('checking');
  try {
    const sim = await api('/api/chain/simulate', { tx: built.tx });
    if (sim.err) {
      const line = (sim.logs || []).reverse().find((l) => /Error|failed|insufficient/i.test(l));
      throw new Error(line ? line.replace(/^Program log:\s*/, '') : 'Transaction would fail');
    }
  } catch (e) { if (!/would fail|Error|insufficient/i.test(e.message)) { /* simulation unavailable — continue */ } else throw e; }

  onStage?.('signing');
  const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
  const tx = web3.Transaction.from(b64ToBytes(built.tx));
  const signed = await signTx(tx);
  onStage?.('sending');
  const { signature } = await api('/api/chain/send', { tx: bytesToB64(signed.serialize()) });
  onStage?.('done');
  return { signature, ...built };
}

export const chainLaunch = (mint) => api(`/api/chain/launch?mint=${encodeURIComponent(mint)}`);
export const chainMe = (mint, wallet) => api(`/api/chain/me?mint=${encodeURIComponent(mint)}&wallet=${encodeURIComponent(wallet)}`);
export const explorer = (sig) => `https://solscan.io/tx/${sig}${/devnet|localhost|127\.0\.0\.1/.test(S.chain?.rpc || '') ? '?cluster=devnet' : ''}`;

/**
 * Sign and send a transaction the SERVER built and the server will keep building — the caller
 * names an endpoint, never an address or an amount.
 *
 * ⛔ Deliberately separate from `act`: that one posts to /api/chain/build/<what> and is for a
 * launcher acting on their own coin. This is for an admin endpoint that decides for itself who is
 * paid and how much, so the browser cannot be talked into funding somewhere else.
 */
export async function signServerTx(path, payload = {}, { onStage } = {}) {
  const p = provider();
  if (!p) { bus.emit('nowallet'); throw new Error('No wallet'); }
  if (!S.me) throw new Error('Sign in first');
  onStage?.('building');
  const built = await api(path, { wallet: S.me.wallet, ...payload });
  onStage?.('signing');
  const web3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
  const tx = web3.Transaction.from(b64ToBytes(built.tx));
  const signed = await signTx(tx);
  onStage?.('sending');
  const { signature } = await api('/api/chain/send', { tx: bytesToB64(signed.serialize()) });
  onStage?.('done');
  return { signature, ...built };
}
