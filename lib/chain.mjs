// On-chain layer: reads REX Chain program state and BUILDS unsigned transactions the user's wallet signs.
// The server never holds a user key — every state change is signed in Phantom and sent by the browser.
import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { cfg, log, warn } from './config.mjs';
import { QUOTES } from './prices.mjs';
// The conviction ladder lives in engine.mjs and is the same one the tiers and points already use —
// imported rather than restated so Diamond Hands payouts can never drift from the tier a holder is
// shown. engine does not import chain, so this adds no cycle.
import { convictionOf } from './engine.mjs';

const IDL_PATH = process.env.REXPAD_IDL || path.join(process.cwd(), 'onchain/target/idl/rexpad.json');
export const enabled = () => fs.existsSync(IDL_PATH) && !!cfg.rpcUrl;

let _idl = null, _conn = null, _program = null;
export function idl() {
  if (_idl) return _idl;
  _idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
  // The override is applied to the IDL ITSELF, not only to programId() below. Anchor takes a
  // Program's id from `idl.address`, so overriding only the helper would leave PDAs deriving under
  // the new id while `account.<x>.all()` still queried the old one — consistent-looking and wrong,
  // which is worse than failing outright. One source of truth, set before anchor ever reads it.
  if (cfg.programId && cfg.programId !== _idl.address) {
    log('chain', `program id overridden: ${_idl.address} -> ${cfg.programId}`);
    _idl.address = cfg.programId;
  }
  return _idl;
}
export const programId = () => new PublicKey(idl().address);
/**
 * The RPC connection.
 *
 * ⛔ `RPC_URL` MAY BE A COMMA-SEPARATED LIST, and the first entry wins. This exists so a paid
 * endpoint can be put in front of the public one without any other change: production has been
 * running on `api.mainnet-beta.solana.com`, which answers every call this app makes but is slow
 * enough that the swap indexer backfills a pool over minutes and lags a busy one. Putting a paid
 * URL first and keeping the public one as the tail gives the fast path plus somewhere to fall back
 * to if the paid endpoint is down or out of credits.
 *
 * A URL is never logged: these carry an API key in the path or the query string.
 *
 * ⛔ THE PUBLIC ENDPOINT IS ALWAYS THE LAST ENTRY, EVEN WHEN NOBODY LISTED IT.
 *
 * The failover below was written to walk down this list, and on 7 Oct it had nowhere to walk: the
 * Helius key in the production secret had stopped working and answered 401 to EVERY method —
 * getHealth, getSlot, getBalance, all of it — while `RPC_URL` held exactly one entry. So the
 * machinery for surviving a dead endpoint sat there with a list of length one and the whole chain
 * layer went down with the key. A free endpoint that is slow is worth having behind a paid one that
 * is refusing us, and the only way to guarantee it is there is to put it there ourselves.
 *
 * It is appended, never prepended, so a working paid endpoint is still the one that serves every
 * call; and it is skipped if the operator already listed it, so the list never carries it twice.
 */
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
/** `raw` is a seam for the tests: config is read once at import, so a test cannot vary it by
 *  reloading this module. Production never passes it. */
export function rpcEndpoints(raw = cfg.rpcUrl) {
  const listed = String(raw || '').split(',').map((u) => u.trim()).filter(Boolean);
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  if (!listed.some((u) => host(u) === 'api.mainnet-beta.solana.com')) listed.push(PUBLIC_RPC);
  return listed;
}
/**
 * ⛔ AN ENDPOINT THAT REFUSES EVERYTHING MUST NOT TAKE THE SITE WITH IT.
 *
 * A fallback was configured and then never used: every call went to the first endpoint and stayed
 * there. When a paid endpoint was added with a mistyped key, Helius answered 401 to EVERY request
 * and the whole chain layer stopped — prices, the swap indexer, holders, the crank — while a
 * perfectly good public endpoint sat second in the list doing nothing. The list is pointless unless
 * something actually moves down it.
 *
 * So every connection method is wrapped: a failure that means "this ENDPOINT is no good" (401, 403,
 * 429, 5xx, a network error) is retried on the next one, and after a few of those in a row the
 * primary is stood down for a cooldown so a dead endpoint is not re-tried on every single call. A
 * failure that means "this REQUEST is no good" — a program error, a bad account — is passed
 * straight through, because retrying it elsewhere would only produce the same answer more slowly.
 */
const ENDPOINT_DEAD = /\b(401|403|429|50\d|502|503|504)\b|unauthoriz|forbidden|rate.?limit|too many requests|fetch failed|socket hang up|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i;
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests|max usage reached/i;
let _demotedUntil = 0, _fails = 0;

/**
 * ⛔ A DEAD RPC MUST NOT BE ABLE TO TAKE THE WEBSITE DOWN. IT DID.
 *
 * The Helius key hit "max usage reached", so every chain read fell through to the public RPC, which
 * rate-limits hard. What happened next is the part worth writing down, because none of it is
 * obvious from the code that caused it:
 *
 *   1. web3.js retries a 429 FIVE times on its own, backing off 0.5s → 1s → 2s → 4s. One read can
 *      therefore sit there for eight seconds holding a socket, and the log fills with lines the
 *      application never asked for.
 *   2. The failover below then retries the whole call on the OTHER endpoint — which is itself the
 *      one being throttled — so a failing read costs twice as many requests as a working one. Load
 *      goes UP exactly when the provider is asking for less.
 *   3. The indexer, the crank, the holder lists and the price refresh all run on timers and do not
 *      wait for each other, so pending reads pile up without any limit. On a shared 1-vCPU machine,
 *      parsing those responses is enough CPU to starve the HTTP server.
 *
 * The result was a site that answered in nine seconds or not at all. Julz reported it as "the search
 * bar still doesn't load anything you search for" — the search was fine; nothing on the page loaded,
 * because the page itself could not be served.
 *
 * Three rules, and all three are needed:
 *
 *   `disableRetryOnRateLimit` turns one read back into one request. Our own failover is better
 *   placed to decide what to do about a 429 than a blind retry inside the client library.
 *
 *   The semaphore caps how much chain work can ever be in flight at once. Whatever the timers ask
 *   for, the process keeps enough room to serve a web request.
 *
 *   The breaker is what the old failover was missing: when BOTH endpoints are rate-limiting, the
 *   right move is to stop asking for a while, not to keep trying the other one. Reads fail fast and
 *   every caller already copes with a failed read — the burn panel hides, a board shows its last
 *   figures — which is a far better site than one that does not load.
 */
/**
 * `disableRetryOnRateLimit` is the single most important flag here. Without it web3.js answers a
 * 429 by sleeping and asking again, five times, inside one call — so the provider's "slow down"
 * is met with four more requests, and the log fills with retry lines no caller asked for.
 */
const RPC_OPTS = { commitment: 'confirmed', disableRetryOnRateLimit: true };
const RPC_MAX_INFLIGHT = Number(process.env.RPC_MAX_INFLIGHT || 6);
/**
 * ⛔ A SEMAPHORE CAPS PARALLELISM, NOT RATE — AND THE PROVIDER LIMITS RATE.
 *
 * Watched this the minute the Helius credits landed. The half-open probe succeeded, the log said
 * "endpoint answering again", and four seconds later it was 429 again — but a DIFFERENT 429. Not
 * "data allowance", which is a spent quota, but "Connection rate limited", which is requests per
 * second. Six in flight against an endpoint answering in 20ms is three hundred requests a second,
 * and limiting concurrency does nothing about that: six go out again the instant six come back.
 *
 * So there is a token bucket as well. It refills at RPC_RATE per second and holds at most a second's
 * worth, which flattens the bursts the timers produce while costing a quiet site nothing — when
 * nothing has been asked for a while the bucket is full and a read goes straight out.
 */
const RPC_RATE = Number(process.env.RPC_RATE || 12);
let _tokens = RPC_RATE, _refilled = Date.now();
/** Milliseconds to wait for a token, or 0 if one was available and has been spent. */
function takeToken() {
  const t = Date.now();
  _tokens = Math.min(RPC_RATE, _tokens + ((t - _refilled) / 1000) * RPC_RATE);
  _refilled = t;
  if (_tokens >= 1) { _tokens -= 1; return 0; }
  // A read that is merely EARLY should still happen, so this is a queue rather than a refusal —
  // unlike the breaker, which is for an endpoint that is not answering at all.
  return Math.ceil(((1 - _tokens) / RPC_RATE) * 1000);
}
async function spendToken() {
  for (;;) {
    const wait = takeToken();
    if (!wait) return;
    await new Promise((r) => setTimeout(r, wait));
  }
}
const RPC_BREAK_MS = Number(process.env.RPC_BREAK_MS || 20_000);
let _inflight = 0; const _queue = [];
let _breakUntil = 0, _rateHits = 0, _rateWindow = 0;
// ⛔ HALF-OPEN, or a recovering endpoint gets re-killed the instant it recovers. Everything in this
// process runs on timers that keep firing while the breaker is open, so the moment it closes a
// backlog arrives all at once — which is precisely the burst that tripped it. After a pause, ONE
// read is let through as a probe; a success opens the gates and a failure starts a fresh pause.
// Without this the breaker oscillates rather than recovering, and the oscillation looks like a
// working RPC that mysteriously never serves anything.
let _probing = false;
// ⛔ "THE PAUSE EXPIRED" IS NOT "THE ENDPOINT IS BACK", and conflating the two meant there was no
// half-open state at all: the moment the clock ran out every waiting caller went through together,
// which is the thundering herd this is supposed to prevent. `_needProbe` stays true from the moment
// the breaker trips until a read actually SUCCEEDS, so the three states are distinct — paused
// (reject everyone), half-open (one probe, reject everyone else), closed (normal).
let _needProbe = false;

function acquire() {
  // Rate first, then a slot. The other order would hold slots idle while they waited for tokens,
  // which throttles the site harder than the provider asks for.
  return spendToken().then(() => {
    if (_inflight < RPC_MAX_INFLIGHT) { _inflight++; return undefined; }
    return new Promise((resolve) => _queue.push(resolve));
  });
}
function release() {
  const next = _queue.shift();
  if (next) next(); else _inflight--;
}
/** Count a 429 and open the breaker if they are arriving in a burst rather than one at a time. */
function noteRateLimit() {
  const t = Date.now();
  if (t - _rateWindow > 10_000) { _rateWindow = t; _rateHits = 0; }
  // A failure while probing means the endpoint is still unwell: pause again immediately rather
  // than waiting for another five hits to accumulate.
  if (_probing) { _probing = false; _breakUntil = t + RPC_BREAK_MS; return; }
  if (++_rateHits >= 5 && t > _breakUntil) {
    _breakUntil = t + RPC_BREAK_MS;
    _needProbe = true;
    warn('rpc', `rate limited on every endpoint — pausing chain reads for ${RPC_BREAK_MS / 1000}s so the site keeps serving`);
  }
}
// ⛔ THIS STRING IS SHOWN TO USERS, SO IT IS WRITTEN FOR THEM. Thirty-two routes in server.mjs
// return `{ error: e.message }` verbatim, so whatever this says lands in front of whoever is
// standing in front of the site — and what it used to say was "rpc paused: every endpoint is rate
// limited, reads are standing down briefly". A launcher mid-form read that on a phone, over the
// live preview of the coin they were about to create, and it tells them nothing they can act on
// and nothing about whether their money moved. The one fact that matters to them is that nothing
// was sent. Said once here rather than translated at thirty-two call sites, because the next route
// somebody adds will forget to translate it too.
//
// It still reads as a diagnostic in a log line, which is the other place it goes.
//
// ⛔ AND IT SAYS HOW LONG, BECAUSE "A FEW SECONDS" WAS NOT TRUE. The pause is RPC_BREAK_MS — twenty
// seconds by default, not a few — so "try again shortly" sent a launcher back after three and got
// them refused again, which reads as a broken site rather than a busy one. Julz pressed Launch into
// exactly this on 24 Oct. The remaining wait is known to the breaker at the moment it refuses, so
// there is no reason to make somebody guess it.
const rpcPausedMsg = () => {
  const left = Math.max(0, _breakUntil - Date.now());
  const secs = Math.max(1, Math.ceil(left / 1000));
  return 'Solana is rate-limiting every endpoint right now, so this is paused for about'
    + ` ${secs} second${secs === 1 ? '' : 's'} — nothing was sent and nothing was charged.`
    + ' Try again then.';
};

/** Work that nobody is waiting on: timers, backfills, sweeps. See `background()`. */
const bg = new AsyncLocalStorage();
/**
 * Run `fn` as BACKGROUND work, so it yields to anyone actually waiting.
 *
 * ⛔ THE RECOVERY PROBE WAS FIRST-COME-FIRST-SERVED, AND BACKGROUND WORK ALWAYS COMES FIRST.
 * When the breaker opens, exactly one read is let through to find out whether the endpoint is back.
 * The timers — poolStatsOf, backfill, the dbc indexer — fire every few seconds and were taking that
 * slot essentially every time, so a person who happened to load the launch page during a pause was
 * refused while a backfill tested the water on their behalf. The site recovered; the user still saw
 * an error. Background callers now never take the probe, which leaves it for whoever is actually
 * waiting on an answer.
 */
export function background(fn) { return bg.run(true, fn); }
const isBackground = () => bg.getStore() === true;

/** The pause is over, but nothing has proved the endpoint is back. Let exactly one read find out. */
function enterHalfOpen() {
  if (_probing) return false;        // somebody else is already the probe
  _probing = true;
  _rateHits = 0;
  return true;
}
function probeSucceeded() {
  if (!_probing) return;
  _probing = false;
  _needProbe = false;
  _rateHits = 0;
  log('rpc', 'endpoint answering again — resuming chain reads');
}
/**
 * Retry a chain read that someone is standing in front of.
 *
 * ⛔ A CLAIM MUST NOT GIVE UP ON ONE REFUSED READ. MiKOL pressed Claim on 72.71 DOGE of creator
 * fees and got "Could not read the pool just now" — and the money was there the whole time: the
 * pool reads back `creatorQuoteFee: 7271224331` reliably, and the SAME call had just succeeded to
 * draw the figure on his screen. The read that failed was the one behind the button, refused by
 * the breaker a second later. Readers like `creatorFeesOf` collapse every failure to `null`, so a
 * route cannot tell a throttled moment from a pool that does not exist — and answered a transient
 * refusal with a dead end that the user had no way to interpret as "press it again".
 *
 * Foreground callers now get the breaker's recovery probe, so a second attempt is likely to be the
 * one that lands. Bounded at under three seconds total, which is a button press, not a hang.
 */
export async function readWithRetry(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

/** For callers and tests that want to know whether the chain is currently answering. */
export const rpcPaused = () => Date.now() < _breakUntil || _probing || _needProbe;
/** True for the ONE caller allowed through to test the water; everyone else keeps waiting. */
function takeProbeSlot() { return !isBackground() && _needProbe && Date.now() >= _breakUntil && enterHalfOpen(); }
export const rpcStats = () => ({ inflight: _inflight, queued: _queue.length, probing: _probing, needProbe: _needProbe, tokens: Math.floor(_tokens), pausedForMs: Math.max(0, _breakUntil - Date.now()) });
function wrap(primary, spare) {
  return new Proxy(primary, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== 'function') return v;
      // ⛔ ONLY THE ROUND TRIPS GO THROUGH THE GATE. `onLogs` returns a subscription id
      // SYNCHRONOUSLY, as do the other on*/remove* members; turning one into a promise would hand
      // the indexer a thenable where it expects a number and quietly break unsubscribing. Matching
      // on the verb covers every actual RPC call — get*, send*, simulate*, confirm*, request* — and
      // leaves the subscription API alone.
      if (!/^(get|send|simulate|confirm|request)[A-Z]/.test(String(prop))) return v.bind(target);
      return function (...args) {
        // One caller may be the probe that finds out whether the endpoint is back; everyone else is
        // refused while the breaker is open, so a recovery is tested by a single read rather than
        // by the whole backlog arriving at once.
        let amProbe = false;
        if (rpcPaused()) {
          amProbe = takeProbeSlot();
          if (!amProbe) {
            const err = new Error(rpcPausedMsg());
            err.rpcPaused = true;
            return Promise.reject(err);
          }
        }
        return acquire().then(() => {
          // ⛔ CHECK THE BREAKER AGAIN HERE, NOT ONLY ABOVE. Everything that fires on a timer calls
          // in the same tick, so two hundred reads can clear the first check before any of them has
          // come back — and then queue behind the semaphore and go out anyway, one slot at a time,
          // long after the endpoint has told us to stop. The second check is the one that actually
          // stops a flood, because by then the first few answers have arrived.
          if (!amProbe && rpcPaused()) {
            release();
            const err = new Error(rpcPausedMsg());
            err.rpcPaused = true;
            throw err;
          }
          const useSpare = spare && Date.now() < _demotedUntil;
          const first = useSpare ? spare : target;
          let out;
          try { out = Reflect.get(first, prop).apply(first, args); }
          catch (e) { release(); throw e; }
          if (!out || typeof out.then !== 'function') { release(); return out; }
          return out.then(
            (r) => { release(); if (amProbe) probeSucceeded(); if (!useSpare) _fails = 0; return r; },
            (e) => {
              const msg = String(e?.message || e);
              if (RATE_LIMITED.test(msg)) noteRateLimit();
              // ⛔ RELEASE THE PROBE SLOT ON ANY FAILURE. noteRateLimit clears it for a 429, but a
              // probe that dies on a timeout or a malformed response would otherwise leave _probing
              // true for ever — and rpcPaused() is true while probing, so every read in the process
              // would be refused permanently by a flag nobody ever clears.
              else if (amProbe) { _probing = false; _needProbe = true; _breakUntil = Date.now() + RPC_BREAK_MS; }
              if (!ENDPOINT_DEAD.test(msg)) { release(); throw e; }
              if (!useSpare && spare && ++_fails >= 3) {
                _demotedUntil = Date.now() + 60_000;   // stand it down, then try it again
                warn('rpc', 'primary endpoint failing — using the fallback for 60s');
              }
              // ⛔ DO NOT RETRY A RATE LIMIT ON THE OTHER ENDPOINT. That is what turned one
              // throttled provider into twice the traffic. A 429 is answered by backing off.
              if (!spare || RATE_LIMITED.test(msg)) { release(); throw e; }
              const other = useSpare ? target : spare;
              return Promise.resolve(Reflect.get(other, prop).apply(other, args))
                .finally(() => release());
            },
          );
        });
      };
    },
  });
}
/** Test seam: the breaker and the semaphore live in the wrapper, and conn() needs a real URL to reach them. */
export const __wrapForTest = (primary, spare) => wrap(primary, spare);

/**
 * ⛔ A PLACEHOLDER IN A SECRET LOOKS EXACTLY LIKE A WORKING CONFIGURATION until the first request
 * comes back 401 — and then every chain read fails at once with an error that says nothing about
 * why. `RPC_URL` was set three times to `?api-key=YOUR_KEY`, straight out of an example, and the
 * only symptom was a log full of "401 Unauthorized". Say it plainly, once, at startup.
 */
export function checkRpcConfig() {
  for (const u of rpcEndpoints()) {
    let k = null;
    try { k = new URL(u).searchParams.get('api-key'); } catch { warn('rpc', 'RPC_URL entry is not a valid URL'); continue; }
    if (k === null) continue;                               // no key in the URL: nothing to judge
    if (/^(your[_-]?key|paste|xxx+|changeme|<.*>)$/i.test(k)) {
      warn('rpc', `⛔ RPC endpoint has a PLACEHOLDER api-key ("${k}") — it will answer 401 to everything. Paste the real key from your provider's dashboard.`);
    } else if (k.length < 20) {
      warn('rpc', `⛔ RPC api-key is only ${k.length} characters and is probably truncated — most providers issue a 36-character key.`);
    }
  }
}

/** Just the hostnames, safe to print. The full URLs carry an API key and must never be logged. */
export function rpcHosts(raw = cfg.rpcUrl) {
  return rpcEndpoints(raw).map((u) => { try { return new URL(u).host; } catch { return '(bad url)'; } });
}

export function conn() {
  if (!_conn) {
    const [primary, ...rest] = rpcEndpoints();
    const a = new Connection(primary, RPC_OPTS);
    _conn = wrap(a, rest.length ? new Connection(rest[0], RPC_OPTS) : null);
  }
  return _conn;
}

/**
 * Does the primary endpoint actually answer us?
 *
 * ⛔ A KEY THAT HAS BEEN REVOKED IS SYNTACTICALLY PERFECT. `checkRpcConfig` reads the SHAPE of the
 * api-key — placeholder text, a truncated string — and a real key that the provider has since
 * stopped honouring passes every one of those checks. Production ran for an unknown number of days
 * on a Helius key that returned 401 to every single method, and the only trace was chain reads
 * quietly costing a fallback hop each. Nobody looks at a log line; the team reported it as "the
 * burn panel doesn't update" and "I can't buy the coin I just launched".
 *
 * So the endpoint is asked, in as many words, whether it will serve us, and the answer is carried
 * in /api/health where it can be seen without an ssh session.
 */
let _rpcProbe = { at: 0, ok: null, status: null, host: null };
export const rpcProbe = () => ({ ..._rpcProbe, paused: rpcPaused() });
export async function probeRpc() {
  const [primary] = rpcEndpoints();
  let host = '(bad url)';
  try { host = new URL(primary).host; } catch {}
  try {
    const r = await fetch(primary, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.json().catch(() => ({}));
    // 200 with an `error` member is still a refusal — some providers answer a disabled method that way.
    const ok = r.ok && !body.error;
    _rpcProbe = { at: Date.now(), ok, status: r.status, host };
    if (!ok) {
      warn('rpc', `⛔ THE PRIMARY RPC ENDPOINT IS REFUSING US — ${host} answered ${r.status}`,
        `${body.error?.message ? '(' + body.error.message + ') ' : ''}· every chain read is falling through to`,
        `${rpcEndpoints().length > 1 ? 'the next endpoint, which is slower and rate-limited' : 'nothing'}`,
        '· rotate the key in the provider dashboard and set it with `flyctl secrets set RPC_URL=...`');
    }
    return _rpcProbe;
  } catch (e) {
    _rpcProbe = { at: Date.now(), ok: false, status: 0, host };
    warn('rpc', `⛔ THE PRIMARY RPC ENDPOINT (${host}) could not be reached: ${e.message}`);
    return _rpcProbe;
  }
}
/**
 * Is the primary endpoint the free public one?
 *
 * Callers use this to size their own appetite. The public RPC answers every call this app makes but
 * rate-limits hard, so the swap indexer deliberately crawls on it; a paid endpoint can be walked an
 * order of magnitude faster. Deciding from the URL rather than from a separate flag means setting
 * one secret changes the behaviour, with nothing left to remember.
 */
export function isPublicRpc() {
  const [u] = rpcEndpoints();
  return !u || /(^|\/\/)(api\.(mainnet-beta|devnet|testnet)\.solana\.com)/.test(u);
}

/** A connection to the NEXT endpoint in the list, for a caller that wants to retry elsewhere. */
export function fallbackConn(i = 1) {
  const list = rpcEndpoints();
  if (list.length <= i) return null;
  return new Connection(list[i], RPC_OPTS);
}
// A read-only provider: anchor needs *a* wallet to construct the Program, but we never sign with it.
function program() {
  if (_program) return _program;
  const provider = new anchor.AnchorProvider(conn(), new anchor.Wallet(Keypair.generate()), { commitment: 'confirmed' });
  _program = new anchor.Program(idl(), provider);
  return _program;
}

// ---------------------------------------------------------------- PDAs
const enc = new TextEncoder();
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId())[0];
export const configPda = () => pda([enc.encode('config')]);
export const launchPda = (mint) => pda([enc.encode('launch'), new PublicKey(mint).toBuffer()]);
export const tokenVaultPda = (launch) => pda([enc.encode('token_vault'), new PublicKey(launch).toBuffer()]);
export const quoteVaultPda = (launch) => pda([enc.encode('quote_vault'), new PublicKey(launch).toBuffer()]);
export const rewardVaultPda = (launch) => pda([enc.encode('reward_vault'), new PublicKey(launch).toBuffer()]);
export const commitPda = (launch, who) => pda([enc.encode('commit'), new PublicKey(launch).toBuffer(), new PublicKey(who).toBuffer()]);
export const positionPda = (launch, who) => pda([enc.encode('position'), new PublicKey(launch).toBuffer(), new PublicKey(who).toBuffer()]);
export const epochPda = (launch, index) => { const b = Buffer.alloc(4); b.writeUInt32LE(index); return pda([enc.encode('epoch'), new PublicKey(launch).toBuffer(), b]); };
export const receiptPda = (epoch, who) => pda([enc.encode('receipt'), new PublicKey(epoch).toBuffer(), new PublicKey(who).toBuffer()]);

// ---------------------------------------------------------------- reads
const statusOf = (s) => (s && typeof s === 'object' ? Object.keys(s)[0] : String(s || '')).toLowerCase();
const n = (v) => (v && typeof v.toString === 'function' ? Number(v.toString()) : Number(v || 0));

// getProgramAccounts is the heaviest RPC call and public endpoints throttle it hard, so the
// crank and the indexer share one short-lived cache instead of each polling independently.
const PA_TTL = Number(process.env.PROGRAM_ACCOUNTS_TTL_MS || 15_000);
const paCache = new Map();   // key -> { at, v }        settled results only
const paInflight = new Map(); // key -> Promise            de-duplicates concurrent callers
async function cached(key, fn) {
  const hit = paCache.get(key);
  if (hit && Date.now() - hit.at < PA_TTL) return hit.v;
  const running = paInflight.get(key);
  if (running) return running;
  const p = fn()
    .then((v) => { paCache.set(key, { at: Date.now(), v }); return v; })
    .catch((e) => { if (hit) return hit.v; throw e; })   // serve stale rather than fail, but only real data
    .finally(() => paInflight.delete(key));
  paInflight.set(key, p);
  return p;
}
export const invalidate = () => { paCache.clear(); paInflight.clear(); };

/** Raw on-chain Launch accounts, normalised to plain numbers. */
export async function launches() { return cached('launches', _launches); }
async function _launches() {
  const rows = await program().account.launch.all();
  return rows.map(({ publicKey, account: a }) => ({
    launch: publicKey.toBase58(),
    mint: a.mint.toBase58(),
    creator: a.creator.toBase58(),
    quoteMint: a.quoteMint.toBase58(),
    vQuote: n(a.vQuote), vToken: n(a.vToken),
    realQuote: n(a.realQuote), realToken: n(a.realToken),
    raiseTarget: n(a.raiseTarget),
    // Fee split, in bps of the QUOTE leg of a swap. `rexBps` is REX's share OF holderBps,
    // not a fifth fee — holders net holderBps * (1 - rexBps/10000).
    holderBps: a.holderBps, creatorBps: a.creatorBps, vaultBps: a.vaultBps, burnBps: a.burnBps,
    buybackBps: a.buybackBps, rexBps: a.rexBps,
    totalFeeBps: a.holderBps + a.creatorBps + a.vaultBps + a.burnBps + a.buybackBps,
    status: statusOf(a.status),
    fairOpenEnds: n(a.fairOpenEnds) * 1000,
    fairOpenTotal: n(a.fairOpenTotal), fairOpenTokens: n(a.fairOpenTokens), fairOpenClaimedQuote: n(a.fairOpenClaimedQuote),
    ammQuote: n(a.ammQuote), ammToken: n(a.ammToken),
    rewardPot: n(a.rewardPot), creatorPot: n(a.creatorPot), vaultPot: n(a.vaultPot),
    burnPot: n(a.burnPot), buybackPot: n(a.buybackPot), rexPot: n(a.rexPot), partnerPot: n(a.partnerPot), volumeQuote: n(a.volumeQuote),
    epochCount: a.epochCount, holders: a.holders,
  }));
}
export async function launchOf(mint) {
  try { const a = await program().account.launch.fetch(launchPda(mint)); return (await launches()).find((l) => l.mint === new PublicKey(mint).toBase58()) || a; }
  catch { return null; }
}
export async function positionOf(mint, owner) {
  try {
    const a = await program().account.position.fetch(positionPda(launchPda(mint), owner));
    return { amount: n(a.amount), heldSince: n(a.heldSince) * 1000 };
  } catch { return { amount: 0, heldSince: 0 }; }
}
export async function commitOf(mint, owner) {
  try { const a = await program().account.commit.fetch(commitPda(launchPda(mint), owner)); return { amount: n(a.amount), claimed: a.claimed }; }
  catch { return { amount: 0, claimed: false }; }
}
/** Every position for one launch — the input the reward crank weights by hold time. */
export async function positionsOf(mint) {
  const launch = launchPda(mint).toBase58();
  const rows = await program().account.position.all([{ memcmp: { offset: 8, bytes: launch } }]);
  return rows.map(({ account: a }) => ({ owner: a.owner.toBase58(), amount: n(a.amount), heldSince: n(a.heldSince) * 1000 }))
    .filter((p) => p.amount > 0);
}
/** Every position across every launch, in one call — what the indexer syncs holders from. */
export async function allPositions() { return cached('positions', _allPositions); }
async function _allPositions() {
  const rows = await program().account.position.all();
  return rows.map(({ account: a }) => ({ launch: a.launch.toBase58(), owner: a.owner.toBase58(), amount: n(a.amount), heldSince: n(a.heldSince) * 1000 }))
    .filter((p) => p.amount > 0);
}
/**
 * Every commitment made into one launch's Fair Open window.
 *
 * The program emits nothing per fill — `claim_fair_open` transfers the tokens and opens a position
 * without an event — so the only way to know who was filled is to read the commitments and redo the
 * program's own arithmetic. These accounts stay on chain after settlement (`claimed` flips, `amount`
 * is kept), which is what makes the fills reconstructable at any time rather than only as they land.
 */
export async function commitsOf(mint) {
  const launch = launchPda(mint).toBase58();
  const rows = await program().account.commit.all([{ memcmp: { offset: 8, bytes: launch } }]);
  return rows.map(({ account: a }) => ({ bidder: a.bidder.toBase58(), amount: n(a.amount), claimed: !!a.claimed }))
    .filter((c) => c.amount > 0);
}
export async function epochsOf(mint) {
  const launch = launchPda(mint).toBase58();
  const rows = await program().account.epoch.all([{ memcmp: { offset: 8, bytes: launch } }]);
  return rows.map(({ publicKey, account: a }) => ({ epoch: publicKey.toBase58(), index: a.index, pot: n(a.pot), claimed: n(a.claimed), ts: n(a.ts) * 1000, root: Buffer.from(a.root).toString('hex') }))
    .sort((x, y) => x.index - y.index);
}
export async function configAccount() {
  try { const c = await program().account.config.fetch(configPda()); return { authority: c.authority.toBase58(), pendingAuthority: c.pendingAuthority.toBase58(), partner: c.partner.toBase58(), partnerBps: c.partnerBps, feeWallet: c.feeWallet.toBase58(), curveFeeBps: c.curveFeeBps, ammFeeBps: c.ammFeeBps, paused: c.paused,
      // The waterfall. Zeroes on a config that predates migrate_config, which is the honest "not set
      // yet" state rather than a split anyone should act on — distribute refuses on version 0.
      waterfallVersion: c.waterfallVersion ?? 0,
      dev2: c.dev2?.toBase58?.() ?? null, dev2Bps: c.dev2Bps ?? 0,
      buyback: c.buyback?.toBase58?.() ?? null, buybackBps: c.buybackBps ?? 0,
      usdcReserve: c.usdcReserve?.toBase58?.() ?? null, usdcBps: c.usdcBps ?? 0,
      plays: c.plays?.toBase58?.() ?? null, playsBps: c.playsBps ?? 0,
      vault: c.vault?.toBase58?.() ?? null, vaultBps: c.vaultBps ?? 0 }; }
  catch { return null; }
}

// ---------------------------------------------------------------- tx building
async function pack(ix, payer, extraSigners = []) {
  const c = conn();
  const tx = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
  tx.feePayer = new PublicKey(payer);
  tx.recentBlockhash = (await c.getLatestBlockhash('confirmed')).blockhash;
  for (const s of extraSigners) tx.partialSign(s);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
// ---------- which token program a mint lives under
//
// Not all of them are the same one. Mainnet $REX is Token-2022 while SOL, USDC and most of the book
// are legacy SPL — and this is not cosmetic: the associated-token ADDRESS is derived from the
// program, so assuming legacy for a Token-2022 mint computes an account that does not exist and the
// instruction fails on an account mismatch. $REX is the headline pair, so getting this wrong would
// have meant REX-quoted launches simply not working on mainnet.
//
// The program itself is already agnostic — it takes Interface<TokenInterface> and creates the launch
// mint and both vaults under whichever program is passed — so a launch quoted in a Token-2022 asset
// just mints a Token-2022 token, and everything lines up. All the client has to do is stop assuming.
const _progCache = new Map();
export async function tokenProgramOf(mint) {
  const key = String(mint);
  const hit = _progCache.get(key);
  if (hit) return hit;
  let prog = TOKEN_PROGRAM_ID;
  try {
    const info = await conn().getAccountInfo(new PublicKey(key), 'confirmed');
    if (info?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) prog = TOKEN_2022_PROGRAM_ID;
  } catch (e) { warn('token program', e.message); }
  _progCache.set(key, prog);
  return prog;
}
const ata = (mint, owner, prog = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, prog);
/** The platform fee account for a quote asset may not exist yet — creating it is idempotent and
 *  costs the payer nothing when it already does. Without this, the FIRST launch in any new quote
 *  asset fails to settle and its first trade fails, with AccountNotInitialized on fee_quote. */
const ensureAta = (payer, mint, owner, prog = TOKEN_PROGRAM_ID) =>
  createAssociatedTokenAccountIdempotentInstruction(new PublicKey(payer), ata(mint, owner, prog), new PublicKey(owner), new PublicKey(mint), prog);

// ---------- native SOL
//
// The program only knows SPL token accounts, and native SOL is not one: a wallet holding 10 SOL has
// an EMPTY wSOL account, so a SOL-quoted launch would reject every buy with insufficient funds from
// someone who plainly has the funds. SOL is the default pair now, so this is the difference between
// the pad working and the pad looking broken to its first user.
//
// Anything that takes quote FROM the user is therefore preceded by a wrap, and anything that sends
// quote TO them is followed by a close — which is also how the temporary account's rent comes back.
// Both are no-ops for every other quote asset.
const NATIVE = NATIVE_MINT.toBase58();
export const isNativeQuote = (mint) => String(mint) === NATIVE;

function wrapSol(user, lamports) {
  const owner = new PublicKey(user), dest = ata(NATIVE, user);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, dest, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: dest, lamports: BigInt(lamports) }),
    createSyncNativeInstruction(dest),   // the token program only sees lamports it has been told about
  ];
}
const unwrapSol = (user) => createCloseAccountInstruction(ata(NATIVE, user), new PublicKey(user), new PublicKey(user));

/** Before an instruction that spends quote. */
const quoteInIxs = (quoteMint, user, lamports, prog) => (isNativeQuote(quoteMint) ? wrapSol(user, lamports) : [ensureAta(user, quoteMint, user, prog)]);
/**
 * ⛔ AN INSTRUCTION THAT *RETURNS* QUOTE NEEDS THE ACCOUNT TO EXIST BEFORE IT RUNS, NOT AFTER.
 *
 * `quoteOut` closed the wrapper afterwards, which is right, and nothing ever opened it, which is
 * not. A SOL-quoted claim therefore asked the program to pay wrapped SOL into an associated token
 * account that had never been created — and nobody holds a standing wSOL account, because wSOL
 * exists only for the seconds inside a swap. The token program's answer to that is "invalid account
 * data for instruction", which names neither the account nor the reason.
 *
 * MiKOL hit it on a creator fee of 0.0390 SOL and sent the log. It is the same wrapped-SOL trap
 * that failed the SOL leg of the protocol payout two days ago, in a third place: the read side was
 * taught about native SOL in October, the SEND side on the 7th, and the CLAIM side never was.
 *
 * The pair is now always used together — open before, close after — so no claim path can acquire
 * half of it again.
 */
const quoteInPrep = (quoteMint, user) => (isNativeQuote(quoteMint) ? [ensureAta(user, NATIVE, user)] : []);
/** After an instruction that returns quote. */
const quoteOut = (quoteMint, user) => (isNativeQuote(quoteMint) ? [unwrapSol(user)] : []);

/** Create a launch. Returns the tx plus the mint keypair's pubkey (the tx is pre-signed by the mint). */
export async function buildCreateLaunch({ creator, quoteMint, raiseTarget, vQuote0, holderBps, creatorBps = 0, vaultBps = 0, burnBps = 0, buybackBps = 0, fairOpenSecs }) {
  // The launch mint and both vaults are created under the SAME program as the quote, so a
  // Token-2022 quote produces a Token-2022 launch and the whole thing stays internally consistent.
  const tp = await tokenProgramOf(quoteMint);
  const mintKp = Keypair.generate();
  const launch = launchPda(mintKp.publicKey);
  const ix = await program().methods
    .createLaunch(new anchor.BN(raiseTarget), new anchor.BN(vQuote0), holderBps, creatorBps, vaultBps, burnBps, buybackBps, new anchor.BN(fairOpenSecs))
    .accounts({
      config: configPda(), launch, mint: mintKp.publicKey, quoteMint: new PublicKey(quoteMint),
      tokenVault: tokenVaultPda(launch), quoteVault: quoteVaultPda(launch), rewardVault: rewardVaultPda(launch),
      creator: new PublicKey(creator), tokenProgram: tp, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).instruction();
  return { tx: await pack(ix, creator, [mintKp]), mint: mintKp.publicKey.toBase58(), launch: launch.toBase58() };
}

/** Creator withdraws their accrued share. Signed by the creator; nobody else can call it. */
export async function buildClaimCreator({ creator, mint }) {
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ix = await program().methods.claimCreator()
    .accounts({ launch, quoteMint: l.quoteMint, rewardVault: rewardVaultPda(launch), beneficiaryQuote: ata(l.quoteMint, creator, tp), beneficiary: new PublicKey(creator), tokenProgram: tp })
    .instruction();
  return { tx: await pack([...quoteInPrep(l.quoteMint, creator), ix, ...quoteOut(l.quoteMint, creator)], creator) };
}

/** Sweep one of the non-holder buckets: 2 = project vault, 3 = burn, 4 = REX. Authority only. */
export const BUCKET = { VAULT: 2, BURN: 3, REX: 4, BUYBACK: 5 };
export async function sweepBucket(mint, bucket, destination, signer = crankKeypair()) {
  const _l0 = await program().account.launch.fetch(launchPda(mint)); const tp = await tokenProgramOf(_l0.quoteMint);
  if (!signer) throw new Error('no crank key configured');
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const ix = await program().methods.sweepBucket(bucket)
    .accounts({ config: configPda(), launch, quoteMint: l.quoteMint, rewardVault: rewardVaultPda(launch), destination: ata(l.quoteMint, destination), authority: signer.publicKey, tokenProgram: tp })
    .instruction();
  return sendAs([ensureAta(signer.publicKey, l.quoteMint, destination), ix], signer);
}

/**
 * Hand the config authority to another key, in two steps. Nothing moves until that key itself calls
 * `acceptAuthority`, so the protocol cannot be bricked by a mistyped pubkey — and nothing else can
 * post an epoch, sweep a bucket or move a REX tier, so being bricked would be terminal.
 * Pass the default pubkey to cancel a pending handover.
 */
export async function proposeAuthority(newAuthority, signer = crankKeypair()) {
  if (!signer) throw new Error('no crank key configured');
  const ix = await program().methods.proposeAuthority(new PublicKey(newAuthority))
    .accounts({ config: configPda(), authority: signer.publicKey }).instruction();
  return sendAs(ix, signer);
}
/** Signed by the INCOMING authority, which proves the key exists and is controlled. */
export async function acceptAuthority(signer) {
  if (!signer) throw new Error('the incoming authority must sign this itself');
  const ix = await program().methods.acceptAuthority()
    .accounts({ config: configPda(), newAuthority: signer.publicKey }).instruction();
  return sendAs(ix, signer);
}

/**
 * Set the revenue share on REX Chain's own cut — ONCE, permanently. `bps` is of REX Chain's cut, not
 * of the trade.
 *
 * ⛔ 300 was WRONG and is why `raisePartner` below exists. It came from reading "10% of the
 * development allocation" as 10% x the 30% Development leg = 3%. Elio's spec is 10 POINTS OF THE
 * WHOLE: 1000 bps. This instruction is one-shot and has already fired on both clusters, so the only
 * way up is `raisePartner`.
 */
export async function setPartner(partner, bps, signer = crankKeypair()) {
  if (!signer) throw new Error('no authority key configured');
  const ix = await program().methods.setPartner(new PublicKey(partner), bps)
    .accounts({ config: configPda(), authority: signer.publicKey }).instruction();
  return sendAs(ix, signer);
}
/**
 * Raise the partner share. Up-only, and that is the whole point.
 *
 * `setPartner` is one-shot, so once it has fired a mistaken number cannot be corrected by calling it
 * again — which is exactly what happened: both clusters were written with 300 bps when Elio's spec
 * is 1000. The program therefore allows a RAISE and nothing else: it rejects any value that is not
 * strictly greater than what is already stored, and anything above PARTNER_MAX_BPS.
 *
 * Up-only matters. A settable share is a share the authority can quietly cut to zero the day the
 * partner stops watching; an up-only one can only ever move in the partner's favour, so the partner
 * does not have to trust whoever holds the authority key.
 */
export async function raisePartner(bps, signer = crankKeypair()) {
  if (!signer) throw new Error('no authority key configured');
  const n = Math.round(Number(bps));
  if (!Number.isFinite(n) || n <= 0) throw new Error('bps must be a positive integer');
  // Read first and refuse locally, so a no-op or a lowering attempt costs nothing and reports a
  // sentence rather than an anchor error code.
  const c = await configAccount();
  if (!c) throw new Error('config unreadable');
  if (n === c.partnerBps) throw new Error(`already ${n} bps — nothing to raise`);
  if (n < c.partnerBps) throw new Error(`refusing to LOWER the partner share (${c.partnerBps} -> ${n}); this instruction is up-only by design`);
  const ix = await program().methods.raisePartner(n)
    .accounts({ config: configPda(), authority: signer.publicKey }).instruction();
  return sendAs(ix, signer);
}

/**
 * Pay one launch's REX bucket out across the five waterfall legs, in a single transaction.
 *
 * Every leg's destination is checked against the config inside the program before a lamport moves,
 * so this cannot be pointed somewhere else even by whoever signs it. Needs `migrateConfig` to have
 * run first — on a config whose `waterfallVersion` is still 0 the program refuses rather than
 * guessing a split.
 */
export async function distribute(mint, signer = crankKeypair()) {
  if (!signer) throw new Error('no authority key configured');
  const launch = launchPda(mint);
  const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const c = await configAccount();
  if (!c) throw new Error('config unreadable');
  const ix = await program().methods.distribute()
    .accounts({
      config: configPda(), launch, quoteMint: l.quoteMint,
      quoteVault: quoteVaultPda(launch),
      dev2: ata(l.quoteMint, c.dev2), buyback: ata(l.quoteMint, c.buyback),
      usdcReserve: ata(l.quoteMint, c.usdcReserve), plays: ata(l.quoteMint, c.plays),
      vault: ata(l.quoteMint, c.vault),
      authority: signer.publicKey, tokenProgram: tp,
    }).instruction();
  return sendAs(ix, signer);
}

/** Rotate which wallet receives the share. Signed by the current partner alone. */
export async function setPartnerWallet(newWallet, signer) {
  if (!signer) throw new Error('the partner must sign this themselves');
  const ix = await program().methods.setPartnerWallet(new PublicKey(newWallet))
    .accounts({ config: configPda(), partner: signer.publicKey }).instruction();
  return sendAs(ix, signer);
}
/** Withdraw the accrued share for one launch. Needs nobody else to have swept anything. */
export async function claimPartner(mint, signer) {
  if (!signer) throw new Error('the partner must sign this themselves');
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ix = await program().methods.claimPartner()
    .accounts({ config: configPda(), launch, quoteMint: l.quoteMint, rewardVault: rewardVaultPda(launch),
      partnerQuote: ata(l.quoteMint, signer.publicKey), partner: signer.publicKey, tokenProgram: tp })
    .instruction();
  return sendAs([ensureAta(signer.publicKey, l.quoteMint, signer.publicKey), ix], signer);
}
/** What the share has accrued on a launch but not yet withdrawn. */
export async function partnerPotOf(mint) {
  try { return n((await program().account.launch.fetch(launchPda(mint))).partnerPot); } catch { return 0; }
}

/** Lower REX's share of the holder bucket as verified volume crosses a tier. Can never raise it. */
export async function setRexTier(mint, rexBps, signer = crankKeypair()) {
  if (!signer) throw new Error('no crank key configured');
  const ix = await program().methods.setRexTier(rexBps)
    .accounts({ config: configPda(), launch: launchPda(mint), authority: signer.publicKey })
    .instruction();
  return sendAs(ix, signer);
}

export async function buildCommit({ bidder, mint, amount }) {
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ix = await program().methods.commit(new anchor.BN(amount))
    .accounts({ launch, commitment: commitPda(launch, bidder), quoteMint: l.quoteMint, quoteVault: quoteVaultPda(launch), bidderQuote: ata(l.quoteMint, bidder, tp), bidder: new PublicKey(bidder), tokenProgram: tp, systemProgram: SystemProgram.programId })
    .instruction();
  return { tx: await pack([...quoteInIxs(l.quoteMint, bidder, amount, tp), ix], bidder) };
}

export async function buildWithdrawCommit({ bidder, mint }) {
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ix = await program().methods.withdrawCommit()
    .accounts({ launch, commitment: commitPda(launch, bidder), quoteMint: l.quoteMint, quoteVault: quoteVaultPda(launch), bidderQuote: ata(l.quoteMint, bidder, tp), bidder: new PublicKey(bidder), tokenProgram: tp })
    .instruction();
  return { tx: await pack([...quoteInPrep(l.quoteMint, bidder), ix, ...quoteOut(l.quoteMint, bidder)], bidder) };
}

export async function buildClaimFairOpen({ bidder, mint }) {
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ix = await program().methods.claimFairOpen()
    .accounts({ launch, commitment: commitPda(launch, bidder), position: positionPda(launch, bidder), mint: l.mint, quoteMint: l.quoteMint, tokenVault: tokenVaultPda(launch), quoteVault: quoteVaultPda(launch), bidderToken: ata(l.mint, bidder, tp), bidderQuote: ata(l.quoteMint, bidder, tp), bidder: new PublicKey(bidder), tokenProgram: tp, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .instruction();
  // A claim hands back the token AND whatever quote did not fill, so the wrapper is closed after it.
  return { tx: await pack([...quoteInPrep(l.quoteMint, bidder), ix, ...quoteOut(l.quoteMint, bidder)], bidder) };
}

async function tradeAccounts(mint, user) {
  const launch = launchPda(mint);
  const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  return {
    config: configPda(), launch, position: positionPda(launch, user), mint: l.mint, quoteMint: l.quoteMint,
    tokenVault: tokenVaultPda(launch), quoteVault: quoteVaultPda(launch), rewardVault: rewardVaultPda(launch),
    userToken: ata(l.mint, user, tp), userQuote: ata(l.quoteMint, user, tp),
    user: new PublicKey(user), tokenProgram: tp, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
}
export async function buildBuy({ user, mint, quoteIn: amountIn, minTokensOut = 0 }) {
  const acc = await tradeAccounts(mint, user);
  const ix = await program().methods.buy(new anchor.BN(amountIn), new anchor.BN(minTokensOut)).accounts(acc).instruction();
  // Wrap exactly what is being spent, then close: the close returns the rent, and leaves the wallet
  // holding SOL rather than a wrapper it never asked for.
  return { tx: await pack([...quoteInIxs(acc.quoteMint, user, amountIn), ix, ...quoteOut(acc.quoteMint, user)], user) };
}
export async function buildSell({ user, mint, tokensIn, minQuoteOut = 0 }) {
  const acc = await tradeAccounts(mint, user);
  const ix = await program().methods.sell(new anchor.BN(tokensIn), new anchor.BN(minQuoteOut)).accounts(acc).instruction();
  return { tx: await pack([ensureAta(user, acc.quoteMint, user), ix, ...quoteOut(acc.quoteMint, user)], user) };
}
export async function buildClaimReward({ claimant, mint, index, amount, proof }) {
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ep = epochPda(launch, index);
  const ix = await program().methods.claimReward(new anchor.BN(amount), proof.map((p) => Array.from(Buffer.from(p, 'hex'))))
    .accounts({ launch, epoch: ep, receipt: receiptPda(ep, claimant), quoteMint: l.quoteMint, rewardVault: rewardVaultPda(launch), claimantQuote: ata(l.quoteMint, claimant, tp), claimant: new PublicKey(claimant), tokenProgram: tp, systemProgram: SystemProgram.programId })
    .instruction();
  return { tx: await pack([ensureAta(claimant, l.quoteMint, claimant, tp), ix, ...quoteOut(l.quoteMint, claimant)], claimant) };
}

/** Relay a wallet-signed transaction and wait for confirmation. */
export async function send(signedB64) {
  const c = conn();
  const raw = Buffer.from(signedB64, 'base64');
  const sig = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const bh = await c.getLatestBlockhash('confirmed');
  const res = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (res.value?.err) throw new Error('transaction failed: ' + JSON.stringify(res.value.err));
  invalidate(); // a write just landed — the next read must not be served from cache
  return sig;
}
/** Simulate a wallet-signed transaction without broadcasting — used to surface errors before the user signs. */
export async function simulate(b64) {
  const { VersionedTransaction } = await import('@solana/web3.js');
  const raw = Buffer.from(b64, 'base64');
  let tx; try { tx = VersionedTransaction.deserialize(raw); } catch { tx = Transaction.from(raw); }
  const r = await conn().simulateTransaction(tx, tx instanceof Transaction ? undefined : { sigVerify: false, replaceRecentBlockhash: true });
  return { err: r.value?.err || null, logs: r.value?.logs || [], units: r.value?.unitsConsumed ?? null };
}

// ---------------------------------------------------------------- crank (server-signed)
// Two operations are not the user's: ringing the Fair Open bell (permissionless — anyone may call it,
// we just make sure somebody does) and posting the reward merkle root (config authority).
import bs58 from 'bs58';
let _crank = null;
export function crankKeypair() {
  if (_crank !== null) return _crank;
  _crank = cfg.crankKey ? Keypair.fromSecretKey(bs58.decode(cfg.crankKey)) : null;
  return _crank;
}
async function sendAs(ix, signer) {
  const c = conn();
  const tx = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(signer);
  const sig = await c.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const bh = await c.getLatestBlockhash('confirmed');
  const r = await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
  if (r.value?.err) throw new Error('crank tx failed: ' + JSON.stringify(r.value.err));
  invalidate();
  return sig;
}
export async function settleFairOpen(mint, signer = crankKeypair()) {
  if (!signer) throw new Error('no crank key configured');
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const tp = await tokenProgramOf(l.quoteMint);
  const ix = await program().methods.settleFairOpen()
    .accounts({ config: configPda(), launch, quoteMint: l.quoteMint, quoteVault: quoteVaultPda(launch), rewardVault: rewardVaultPda(launch), cranker: signer.publicKey, tokenProgram: tp })
    .instruction();
  return sendAs(ix, signer);
}
export async function postEpoch(mint, root, pot, signer = crankKeypair()) {
  if (!signer) throw new Error('no crank key configured');
  const launch = launchPda(mint); const l = await program().account.launch.fetch(launch);
  const ix = await program().methods.postEpoch(Array.from(root), new anchor.BN(pot))
    .accounts({ config: configPda(), launch, epoch: epochPda(launch, l.epochCount), authority: signer.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return sendAs(ix, signer);
}
/**
 * `curveFeeBps`, `ammFeeBps` and `feeWallet` are inert: there is no platform fee. They stay in the
 * Config account for layout compatibility only — REX Chain's revenue is the `rex_bps` slice of each
 * launch's holder bucket, withdrawn with sweepBucket(BUCKET.REX).
 */
export async function initConfig({ curveFeeBps = 100, ammFeeBps = 25, feeWallet, partner = cfg.partnerWallet, partnerBps = cfg.partnerBps, signer = crankKeypair() } = {}) {
  if (!signer) throw new Error('no crank key configured');
  const ix = await program().methods.initConfig(curveFeeBps, ammFeeBps, new PublicKey(partner), partnerBps)
    .accounts({ config: configPda(), authority: signer.publicKey, feeWallet: new PublicKey(feeWallet || signer.publicKey), systemProgram: SystemProgram.programId })
    .instruction();
  return sendAs(ix, signer);
}
/**
 * The three instructions that move a graduated launch into a Raydium pool, as ONE transaction.
 *
 * The order is the whole safety argument. `migrate_release` hands the reserves to the migrator,
 * Raydium's `initialize` builds the pool from them, the LP is burned, and `migrate_confirm` refuses
 * unless the pool exists at Raydium's own seeds, holds what was released, and has zero LP supply.
 * One transaction, so a migrator who takes the reserves and skips the rest has the release reverted
 * along with everything else. It is atomicity doing the work a PDA signature cannot: Raydium bills
 * its creation fee with a System transfer from the pool creator, and System will not move lamports
 * out of a program-owned account, so a PDA of ours could never be that creator.
 */
export async function buildMigrate({ mint, migrator }) {
  const R = await import('./raydium.mjs');
  const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createBurnInstruction, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  const launch = launchPda(mint);
  const l = await program().account.launch.fetch(launch);
  const quoteMint = l.quoteMint.toBase58(), tokenMint = l.mint.toBase58();
  const tp = await tokenProgramOf(tokenMint), qp = await tokenProgramOf(quoteMint);
  const who = new PublicKey(migrator);

  const acc = await R.migrateAccounts({
    launch: launch.toBase58(), mint: tokenMint, quoteMint,
    tokenVault: tokenVaultPda(launch).toBase58(), quoteVault: quoteVaultPda(launch).toBase58(),
    payer: migrator, tokenProgramOf,
  });
  const migratorToken = ata(tokenMint, migrator, tp);
  const migratorQuote = ata(quoteMint, migrator, qp);
  const migratorLp = getAssociatedTokenAddressSync(acc._lpMint, who, false, TOKEN_PROGRAM_ID);

  const release = await program().methods.migrateRelease()
    .accounts({ launch, mint: l.mint, quoteMint: l.quoteMint, tokenVault: tokenVaultPda(launch),
      quoteVault: quoteVaultPda(launch), migratorToken, migratorQuote, migrator: who,
      tokenProgram: tp, quoteTokenProgram: qp })
    .instruction();

  const confirm = await program().methods.migrateConfirm()
    .accounts({ launch, mint: l.mint, quoteMint: l.quoteMint, cpSwapProgram: R.CPMM,
      ammConfig: acc.ammConfig, poolState: acc._pool, lpMint: acc._lpMint,
      poolVault0: acc.poolVault0, poolVault1: acc.poolVault1 })
    .instruction();

  const [m0] = R.sortMints(tokenMint, quoteMint);
  const tokenIs0 = m0 === tokenMint;
  const init = R.initializeIx({
    ...acc,
    creator: who,
    creatorToken0: tokenIs0 ? migratorToken : migratorQuote,
    creatorToken1: tokenIs0 ? migratorQuote : migratorToken,
    creatorLpToken: migratorLp,
    initAmount0: tokenIs0 ? BigInt(l.ammToken) : BigInt(l.ammQuote),
    initAmount1: tokenIs0 ? BigInt(l.ammQuote) : BigInt(l.ammToken),
  });

  return {
    ixs: [
      ensureAta(migrator, tokenMint, migrator, tp),
      ensureAta(migrator, quoteMint, migrator, qp),
      release,
      init,
      // Burn every LP the pool just minted. Raydium only ever mints `liquidity - 100`, so this
      // leaves the supply at exactly zero — which is what migrate_confirm insists on.
      createBurnInstruction(migratorLp, acc._lpMint, who,
        R.lpMintedFor(tokenIs0 ? l.ammToken : l.ammQuote, tokenIs0 ? l.ammQuote : l.ammToken),
        [], TOKEN_PROGRAM_ID),
      confirm,
    ],
    pool: acc._pool.toBase58(), lpMint: acc._lpMint.toBase58(), migratorLp: migratorLp.toBase58(),
    amounts: { quote: Number(l.ammQuote), tokens: Number(l.ammToken) },
  };
}

/** Cluster time, which is what the program compares against — it can drift from wall-clock. */
export async function clusterTime() {
  try { const t = await conn().getBlockTime(await conn().getSlot('confirmed')); if (t) return t * 1000; } catch {}
  return Date.now();
}
/**
 * Devnet faucet: mint a test quote asset to a wallet so testers can actually trade.
 * Guarded by FAUCET_MINT being set, which production never does.
 *
 * `symbol` picks WHICH quote to hand out. Minting only the default one made every tab except Quote
 * useless in practice: a tester could launch a META- or xStock-quoted coin and then have nothing to
 * buy it with. Only assets we minted the stand-in for are dispensable — the faucet checks that it
 * actually holds mint authority rather than assuming, so asking for a real mainnet mint fails
 * honestly instead of producing a confusing on-chain error.
 */
export async function faucet(wallet, signer = crankKeypair(), symbol = '') {
  if (!cfg.faucetMint) throw new Error('faucet is not enabled');
  if (!signer) throw new Error('no crank key configured');
  const { createMintToInstruction, getMint } = await import('@solana/spl-token');
  const want = String(symbol || '').toUpperCase();
  const q = want ? Object.values(QUOTES).find((x) => x.symbol.toUpperCase() === want) : null;
  if (want && !q) throw new Error(`unknown asset ${want}`);
  if (q?.unavailable) throw new Error(`${q.symbol} has no ${q.unavailable} stand-in to hand out`);
  const mint = new PublicKey(q ? q.mint : cfg.faucetMint);
  if (q && q.symbol === 'SOL') throw new Error('SOL is handed out as lamports, not minted');

  // Decimals come from the MINT, not from a constant. The stand-ins are not all six: Monero is 12,
  // the xStocks are 8, HYPE and TAO are 9. Scaling everything by 1e6 would have handed out a
  // millionth of the intended amount of XMR and a hundredth of each xStock.
  const info = await getMint(conn(), mint).catch(() => null);
  if (!info) throw new Error('that mint does not exist on this cluster');
  if (!info.mintAuthority || !info.mintAuthority.equals(signer.publicKey)) {
    throw new Error(`${q?.symbol || 'that asset'} is not a faucet mint — nothing here can issue it`);
  }
  const dest = ata(mint, wallet);
  const amount = Math.round(cfg.faucetAmount * 10 ** info.decimals);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, dest, new PublicKey(wallet), mint),
    createMintToInstruction(mint, dest, signer.publicKey, amount),
  ];

  // Quote tokens alone are not enough to do anything: creating a launch pays rent for a mint, the
  // launch account and three vaults, and every signature costs a fee. A wallet that arrives empty
  // would get its tokens and then fail at the first transaction with a message about lamports, so
  // top it up to a working floor — but only from what the crank can spare, and only if it is short.
  let sol = 0;
  const floor = Math.round(Number(cfg.faucetSol || 0.05) * LAMPORTS_PER_SOL);
  if (floor > 0) {
    const [have, crankHas] = await Promise.all([
      conn().getBalance(new PublicKey(wallet)),
      conn().getBalance(signer.publicKey),
    ]);
    const reserve = Math.round(0.08 * LAMPORTS_PER_SOL);   // the crank still has epochs to post
    const give = Math.min(floor - have, Math.max(0, crankHas - reserve));
    if (have < floor && give > 0) {
      ixs.push(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(wallet), lamports: give }));
      sol = give / LAMPORTS_PER_SOL;
    }
  }
  const sig = await sendAs(ixs, signer);
  return { signature: sig, amount: cfg.faucetAmount, mint: mint.toBase58(), symbol: q?.symbol || 'REX', sol };
}

/** Ring the bell on every Fair Open whose window has passed. Safe to call on a timer.
 *  Uses CLUSTER time: the program checks Clock::get(), and judging by wall-clock makes the crank
 *  call too early (WindowOpen) whenever the cluster runs behind. */
export async function settleDue() {
  const now = await clusterTime();
  const due = (await launches()).filter((l) => l.status === 'fairopen' && l.fairOpenEnds <= now);
  const done = [];
  for (const l of due) { try { done.push({ mint: l.mint, sig: await settleFairOpen(l.mint) }); } catch (e) { warn('settle', l.mint.slice(0, 6), e.message); } }
  return done;
}

// ---------------------------------------------------------------- merkle (must match math.rs verify_proof)
import crypto from 'node:crypto';
const sha = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
export function leafOf(wallet, amount, epoch) {
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(BigInt(amount));
  return sha(new PublicKey(wallet).toBuffer(), amt, new PublicKey(epoch).toBuffer());
}
export function buildTree(leaves) {
  let level = leaves.map((l) => Buffer.from(l));
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; }
      const [a, b] = [level[i], level[i + 1]];
      next.push(Buffer.compare(a, b) <= 0 ? sha(a, b) : sha(b, a));
    }
    level = next; layers.push(level);
  }
  return { root: level[0], layers };
}
export function proofFor(layers, index) {
  const proof = []; let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sib < layer.length) proof.push(layer[sib].toString('hex'));
    idx = Math.floor(idx / 2);
  }
  return proof;
}
/** Conviction weights, computed off-chain from the on-chain clock, then committed as a merkle root. */
/**
 * The epoch snapshot the locked spec calls for: PRO-RATA TO BALANCE, with a floor of the
 * quote-asset equivalent of $20 and the pool, vault, burner and team-lock wallets excluded.
 * Hold time does not weigh a share at all.
 *
 * `priceUsd` is the launched token's price in USD; `exclude` is the set of wallets that never earn.
 */
/**
 * Split a reward pot between holders.
 *
 * Two modes, both shipped, chosen per launch by whoever launched it (Elio's call, 3 Oct):
 *
 *   'hold'  Diamond Hands — the default. weight = balance x conviction multiplier, where the
 *           multiplier runs 1.0x to 3.0x by hours held on the LADDER. A three-day holder earns 3x
 *           what a same-sized wallet that bought a minute ago earns, and because `held_since` is
 *           cleared on a sell, selling resets that clock to zero. This makes the King List a
 *           payslip rather than a trophy.
 *
 *   'flat'  Pro-rata to balance alone. Simple, and the biggest bag wins however briefly it has
 *           been held.
 *
 * The eligibility floor is applied to BALANCE, never to the weighted figure, in both modes. Letting
 * conviction lift a dust position over the floor would pay out accounts the floor exists to exclude,
 * and the multiplier is meant to rank holders who already qualify — not to admit new ones.
 */
export function proRata(positions, { priceUsd = 0, floorUsd = 20, exclude = new Set(), mode = 'hold',
  payout = 'all', payoutN = 25, now = Date.now() } = {}) {
  const floorTokens = priceUsd > 0 ? floorUsd / priceUsd : 0;
  let eligible = positions.filter((p) => p.amount > 0 && !exclude.has(p.owner) && p.amount >= floorTokens);
  let skipped = positions.filter((p) => p.amount > 0 && (exclude.has(p.owner) || p.amount < floorTokens));

  // WHO gets paid, which is a separate question from how much each of them gets. The floor above
  // still applies first in every rule — these narrow the eligible set, they never widen it, so a
  // rule can never pay somebody the floor already excluded.
  if (payout === 'whale' || payout === 'shrimp') {
    const n = Math.max(1, Math.min(10_000, Math.floor(payoutN)));
    const ranked = [...eligible].sort((a, b) => b.amount - a.amount);
    const chosen = payout === 'whale' ? ranked.slice(0, n) : ranked.slice(n);
    const keep = new Set(chosen.map((p) => p.owner));
    skipped = skipped.concat(eligible.filter((p) => !keep.has(p.owner)));
    eligible = chosen;
  }

  // A position with no held_since has either never been seen holding or has sold; convictionOf
  // treats that as zero hours, which is the bottom rung at 1.0x rather than a zero weight. A holder
  // whose history we cannot read must still be paid their balance share.
  const weightOf = (p) => {
    if (mode !== 'hold') return p.amount;
    const since = p.heldSince ?? p.held_since ?? null;
    return p.amount * convictionOf(since, now).mult;
  };
  // 'equal' is a FLAT DIVIDEND: every eligible wallet takes the same amount regardless of size or
  // hold time. It deliberately overrides the weighting above, because an equal split that still
  // weighted by balance would not be equal.
  const withWeight = payout === 'equal'
    ? eligible.map((p) => ({ ...p, weight: 1 }))
    : eligible.map((p) => ({ ...p, weight: weightOf(p) }));
  const total = withWeight.reduce((s, p) => s + p.weight, 0);
  return {
    weighted: withWeight.map((p) => ({ ...p, share: total > 0 ? p.weight / total : 0 })),
    skipped, total, floorTokens, mode, payout,
  };
}

export function allocate(weighted, total, pot) {
  if (!(total > 0) || !(pot > 0)) return [];
  const out = weighted.map((p) => ({ ...p, amount: Math.floor(pot * p.weight / total) })).filter((p) => p.amount > 0);
  return out;
}



/**
 * The crank wallet's address and SOL, for diagnosis.
 *
 * ⛔ Added because a launch froze and nothing said why. The crank signs every Fair Open settle, so
 * when it runs out of SOL the window closes and never clears — the coin sits in `fairopen` and the
 * buy button does nothing, with no error anywhere that names the cause. The balance is cached so a
 * health check cannot turn into an RPC hammer.
 */
export const crankAddress = () => { try { return crankKeypair()?.publicKey.toBase58() || null; } catch { return null; } };
let _crankSol = { v: null, at: 0 };
export const crankSolCached = () => _crankSol.v;
export async function crankBalance() {
  const kp = (() => { try { return crankKeypair(); } catch { return null; } })();
  if (!kp) return null;
  if (Date.now() - _crankSol.at < 30_000) return _crankSol.v;
  try { _crankSol = { v: (await conn().getBalance(kp.publicKey)) / 1e9, at: Date.now() }; }
  catch { _crankSol.at = Date.now() - 25_000; }
  return _crankSol.v;
}

/**
 * What a wallet can actually spend of a given mint, read from chain.
 *
 * ⛔ THE BUG THIS EXISTS FOR: the launch form offered a dev buy with no idea whether the launcher
 * held any of the quote asset. While the SIM faucet was credited on mainnet it looked fine, because
 * everyone "had" 5,000,000 REX. The moment the faucet was correctly disabled, a dev buy quoted in
 * REX built a transaction, asked for a signature, and died in simulation with
 * `TokenzQd… TransferChecked / insufficient funds / 0x1` — a program-log dump as the entire
 * explanation for "you own none of the token you are trying to spend".
 *
 * Returns BOTH numbers because they fail differently and the difference is the confusing case:
 *  - `spendable` is the ATA, which is the only account a DBC swap will draw on.
 *  - `total` sums every account the wallet owns for that mint. When total > spendable the wallet
 *    genuinely holds the token, just not where the swap can reach it, and "you have 0" would be a
 *    lie. Tell them to consolidate instead.
 */
export async function heldOf(owner, mint) {
  const prog = await tokenProgramOf(mint);
  const res = { spendable: 0n, total: 0n, decimals: 0, program: prog.toBase58() };

  // ⛔ NATIVE SOL IS NOT A TOKEN ACCOUNT, AND A SOL-QUOTED LAUNCH IS PAID IN NATIVE SOL.
  //
  // The quote mint for a SOL pair is So111…112 — WRAPPED SOL. Reading token accounts for it finds
  // nothing, because wSOL exists only for the seconds inside a swap that wraps and unwraps it;
  // nobody holds a standing wSOL account. So this returned 0 for every SOL-quoted launcher, the
  // opening-buy guard concluded they held none, and the site told people with plenty of SOL to
  // "add 0.2100 more SOL to this wallet". Julz hit it repeatedly — logged out and back in three
  // times, because nothing about the message suggested the balance was being read from the wrong
  // place. Meteora wraps the native balance as part of the launch transaction, so native SOL is
  // exactly what pays for it, and native SOL is what has to be counted.
  if (String(mint) === NATIVE_MINT.toBase58()) {
    res.decimals = 9;
    try {
      const lamports = BigInt(await conn().getBalance(new PublicKey(owner), 'confirmed'));
      // Any standing wSOL still counts — it is the same asset, and a wallet mid-swap may hold some.
      let wrapped = 0n;
      try {
        const accts = await conn().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: NATIVE_MINT }, 'confirmed');
        for (const { account } of accts.value) wrapped += BigInt(account.data?.parsed?.info?.tokenAmount?.amount || '0');
      } catch { /* a missing wSOL account is the normal case, not an error */ }
      res.total = lamports + wrapped;
      res.spendable = res.total;
      return res;
    } catch (e) { warn('heldOf native', e.message); return null; }   // null = UNKNOWN, never "zero"
  }

  try {
    // Decimals come from the MINT, not from a token account. A wallet holding none of an asset has
    // no token account to read them from, and reporting 0 there makes any caller that formats a
    // REQUESTED amount against this field off by a factor of a million.
    const mi = await conn().getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    res.decimals = mi?.value?.data?.parsed?.info?.decimals ?? 0;
  } catch (e) { warn('heldOf mint', e.message); }
  try {
    const accts = await conn().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
    const want = ata(mint, owner, prog).toBase58();
    for (const { pubkey, account } of accts.value) {
      const info = account.data?.parsed?.info?.tokenAmount;
      if (!info) continue;
      const raw = BigInt(info.amount || '0');
      res.total += raw;
      if (pubkey.toBase58() === want) res.spendable = raw;
    }
  } catch (e) { warn('heldOf', e.message); return null; }  // null = UNKNOWN, never "zero"
  return res;
}

/**
 * Sweep every one of a wallet's token accounts for a mint into its associated token account.
 *
 * ⛔ WHY A LAUNCH CAN FAIL WITH THE MONEY SITTING RIGHT THERE. A pool's opening buy draws on the
 * ATA and nothing else, but a wallet can hold the same mint in several accounts — bridges, some
 * wallets and a few exchanges create auxiliary ones — so `heldOf` reports a healthy total next to a
 * spendable of zero. Fco hit exactly this: 0.0584 TSLAx held, 0 reachable, and the form told him to
 * "consolidate it", which is true, unhelpful, and not something a launch form had any way to do.
 *
 * This is that sentence made into a button. Every non-ATA account is transferred in full to the
 * ATA, which is created first if it does not exist. `transferChecked` rather than `transfer`,
 * because it carries the decimals and the chain verifies them — the one guard against a UI that has
 * the wrong scale moving the wrong amount.
 */
export async function buildConsolidate(owner, mint) {
  const prog = await tokenProgramOf(mint);
  const dest = ata(mint, owner, prog);
  const info = await conn().getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const decimals = info?.value?.data?.parsed?.info?.decimals;
  if (!Number.isInteger(decimals)) throw new Error('could not read that mint, so nothing can be moved safely');

  const accts = await conn().getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
  const want = dest.toBase58();
  const sources = accts.value
    .map(({ pubkey, account }) => ({ pubkey, raw: BigInt(account.data?.parsed?.info?.tokenAmount?.amount || '0') }))
    .filter((a) => a.pubkey.toBase58() !== want && a.raw > 0n);
  if (!sources.length) throw new Error('everything is already in the account the pool draws on');

  const ixs = [createAssociatedTokenAccountIdempotentInstruction(new PublicKey(owner), dest, new PublicKey(owner), new PublicKey(mint), prog)];
  // Capped so one transaction cannot grow past the size limit. A wallet with more scattered accounts
  // than this consolidates in two goes, which is better than a transaction that cannot be sent.
  for (const src of sources.slice(0, 12)) {
    ixs.push(createTransferCheckedInstruction(src.pubkey, new PublicKey(mint), dest, new PublicKey(owner), src.raw, decimals, [], prog));
  }
  const moved = sources.slice(0, 12).reduce((a, b) => a + b.raw, 0n);
  return { tx: await pack(ixs, owner), accounts: Math.min(sources.length, 12), moved: moved.toString(), decimals };
}

// ---------------------------------------------------------------- shared with the Meteora venue
//
// A coin on Meteora DBC is traded by that program, not by ours, so its swap transaction is built by
// the Meteora SDK — but everything AROUND the swap is identical to our own curve: the same payer,
// the same blockhash, the same wrapped-SOL dance, the same idempotent ATA creation. These were
// private to this module while it was the only venue. They are exported so the DBC trade route can
// reuse them instead of growing a second, subtly different copy of the wrapping rules.
export const packTx = pack;
export const ensureAtaIx = (payer, mint, owner, prog) => ensureAta(payer, mint, owner, prog);
/** Instructions that must run BEFORE a swap so `amount` of `quoteMint` is spendable. */
export const quoteInPrefix = (quoteMint, user, amount, prog) => quoteInIxs(quoteMint, user, amount, prog);
/** And after it, so a wrapper the user never asked for does not linger. */
export const quoteOutSuffix = (quoteMint, user) => quoteOut(quoteMint, user);
/** The other half of quoteOutSuffix — run these BEFORE the instruction that returns quote.
 *  Named apart from `quoteInPrefix`, which is for instructions that SPEND quote and has to fund
 *  the wrapper as well as open it; this one only opens it, because the program does the funding. */
export const quoteOutPrefix = (quoteMint, user) => quoteInPrep(quoteMint, user);
export const isNative = (mint) => isNativeQuote(mint);

// ---------------------------------------------------------------- who the protocol's money is for
/**
 * The wallets REX Chain's own income flows to, read from the on-chain config.
 *
 * This is the gate on the earnings dashboard, and it is deliberately derived rather than listed in
 * a constant or an env var: the waterfall can be changed on chain by `migrate_config`, and a gate
 * kept in a second place is a gate that silently stops matching the money. Whoever the chain says
 * gets paid is whoever may look at what has been earned.
 *
 * Returns a Set of base58 strings, or null if the config cannot be read — which callers must treat
 * as "cannot authorise", never as "nobody is allowed" and never as "everybody is".
 */
export async function protocolWallets() {
  try {
    const c = await configAccount();
    if (!c) return null;
    const keys = ['authority', 'partner', 'feeWallet', 'dev2', 'buyback', 'usdcReserve', 'plays', 'vault'];
    const out = new Set();
    for (const k of keys) {
      const v = c[k];
      // The zero address is the "unset" value for an optional leg, not a wallet anybody holds.
      if (typeof v === 'string' && v && v !== '11111111111111111111111111111111') out.add(v);
    }
    return out.size ? out : null;
  } catch (e) { warn('protocolWallets', e.message); return null; }
}

/** The waterfall as the chain currently states it, for showing where the money goes. */
export async function waterfall() {
  const c = await configAccount();
  if (!c) return null;
  const legs = [
    { key: 'partner', label: 'Partner', wallet: c.partner, bps: c.partnerBps },
    { key: 'dev2', label: 'Dev', wallet: c.dev2, bps: c.dev2Bps },
    { key: 'buyback', label: 'Buyback', wallet: c.buyback, bps: c.buybackBps },
    { key: 'usdcReserve', label: 'USDC reserve', wallet: c.usdcReserve, bps: c.usdcBps },
    { key: 'plays', label: 'Plays', wallet: c.plays, bps: c.playsBps },
    { key: 'vault', label: 'Vault', wallet: c.vault, bps: c.vaultBps },
  ].filter((l) => l.wallet && l.bps > 0);
  return { legs, totalBps: legs.reduce((s, l) => s + (l.bps || 0), 0), authority: c.authority, paused: c.paused };
}
