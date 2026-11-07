// Jupiter swaps, with REX's own fee on top — "integrate Jupiter in backend like dexscreener does,
// and charge 0.5% fee on every swap".
//
// Everything goes through the server rather than the browser calling Jupiter directly, for one
// reason that matters: the fee is OURS to set. A browser that builds its own quote URL can simply
// drop platformFeeBps, so the parameter is injected here and the client's value is ignored.
//
// Jupiter is mainnet-only. That is true no matter what cluster the rest of the site is pointed at,
// so this module keeps its own RPC and never borrows the one in chain.mjs — a swap built against a
// mainnet blockhash has to be broadcast to mainnet or it is just a signed string.
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { cfg, warn } from './config.mjs';

const API = (process.env.JUP_API || 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, '');
const TOKEN_API = (process.env.JUP_TOKEN_API || 'https://lite-api.jup.ag/tokens/v2').replace(/\/$/, '');
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let _conn = null;
const conn = () => (_conn ||= new Connection(cfg.jupRpc, 'confirmed'));

export const enabled = () => !!cfg.jupRpc;
export const feeBps = () => (cfg.jupFeeWallet ? Math.max(0, Math.min(500, cfg.jupFeeBps)) : 0);

/** Guard every value we forward. A proxy that passes strings through is a proxy with an open query. */
export function validate(params) { return clean(params); }
function clean({ inputMint, outputMint, amount, slippageBps }) {
  if (!MINT.test(String(inputMint || ''))) throw new Error('bad input mint');
  if (!MINT.test(String(outputMint || ''))) throw new Error('bad output mint');
  if (inputMint === outputMint) throw new Error('pick two different tokens');
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1e18) throw new Error('bad amount');
  const slip = Math.max(1, Math.min(5000, Math.floor(Number(slippageBps) || 50)));
  return { inputMint, outputMint, amount: amt, slippageBps: slip };
}

/**
 * Where our cut lands. Jupiter takes the platform fee into a token account for one of the route's
 * mints, so it has to be an ATA of the fee wallet that ALREADY EXISTS — Jupiter will not create it,
 * and a swap naming an account that is not there fails on chain.
 *
 * So: if the account is missing we quote with NO fee rather than build a transaction that reverts.
 * Collecting nothing on a swap that works beats collecting nothing on a swap that does not, and the
 * user is never the one who pays for our setup being incomplete. tools/jup-fee-accounts.mjs opens
 * them; whatever it has not opened yet simply trades fee-free.
 */
const ataCache = new Map();   // mint -> { at, account|null }
export async function feeAccountFor(mint) {
  if (!cfg.jupFeeWallet || !MINT.test(mint)) return null;
  const hit = ataCache.get(mint);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.account;
  let account = null;
  try {
    // The associated-token address DERIVES from the token program, and not every mint uses the same
    // one — $REX itself is Token-2022 while USDC and the rest are legacy SPL. Assuming legacy
    // computes an address that does not exist, so the fee silently came back zero on exactly the
    // pair we most want it on. Ask the mint which program owns it.
    const mintInfo = await conn().getAccountInfo(new PublicKey(mint), 'confirmed');
    const owner = mintInfo?.owner?.toBase58();
    const prog = owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID
      : owner === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : null;
    if (prog) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(cfg.jupFeeWallet), true, prog);
      const info = await conn().getAccountInfo(ata, 'confirmed');
      if (info) account = ata.toBase58();
    }
  } catch (e) { warn('jup fee account', e.message); }
  ataCache.set(mint, { at: Date.now(), account });
  return account;
}

export async function quote(params) {
  const q = clean(params);
  const fee = await feeAccountFor(q.outputMint);
  const u = new URL(API + '/quote');
  u.searchParams.set('inputMint', q.inputMint);
  u.searchParams.set('outputMint', q.outputMint);
  u.searchParams.set('amount', String(q.amount));
  u.searchParams.set('slippageBps', String(q.slippageBps));
  if (fee && feeBps() > 0) u.searchParams.set('platformFeeBps', String(feeBps()));
  const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new Error(j?.error || `Jupiter returned ${r.status}`);
  return { quote: j, feeAccount: fee, feeBps: fee ? feeBps() : 0 };
}

export async function build({ quoteResponse, userPublicKey }) {
  if (!MINT.test(String(userPublicKey || ''))) throw new Error('bad wallet');
  if (!quoteResponse || typeof quoteResponse !== 'object') throw new Error('bad quote');
  // Re-derive the fee account from the quote rather than trusting one sent up with it.
  const fee = await feeAccountFor(String(quoteResponse.outputMint || ''));
  const body = {
    quoteResponse, userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: 'medium' } },
    ...(fee ? { feeAccount: fee } : {}),
  };
  const r = await fetch(API + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.swapTransaction) throw new Error(j?.error || `Jupiter returned ${r.status}`);
  return { tx: j.swapTransaction, lastValidBlockHeight: j.lastValidBlockHeight };
}

/**
 * Can this wallet pay for a swap at all?
 *
 * ⛔ THE CATCH-22 THIS EXISTS FOR. Elio, 24 Oct: 27,000 REX → SOL, "Simulation failed … Logs: []".
 * A Solana address holding zero lamports is not an account at all, so the fee payer was simply not
 * there and preflight died before a single program ran — which is exactly why the logs were empty.
 * Reproduced from a fresh keypair: `err: "AccountNotFound", logs: []`, byte for byte what he saw.
 *
 * Someone swapping a token TO GET their first SOL is the commonest way to arrive here, and it can
 * never succeed: the network charges a fee in SOL to hand you SOL. No wording on the failure fixes
 * that — the page has to say so BEFORE the button is pressed, which is what this answers.
 *
 * The floor covers a signature, a medium priority fee, and the rent for the temporary wrapped-SOL
 * account a route to or from SOL needs. That rent comes back when the account closes, but it has to
 * be payable first, so it counts.
 */
export const FEE_FLOOR = 2_500_000;                      // 0.0025 SOL
export async function readiness(wallet) {
  if (!MINT.test(String(wallet || ''))) throw new Error('bad wallet');
  const lamports = await conn().getBalance(new PublicKey(wallet), 'confirmed');
  return { lamports, floor: FEE_FLOOR, enough: lamports >= FEE_FLOOR };
}

/**
 * Plain words for a refused broadcast.
 *
 * ⛔ WHAT WAS SHOWN INSTEAD. web3.js throws a SendTransactionError whose message is a note to a
 * DEVELOPER — "Catch the `SendTransactionError` and call `getLogs()` on it for full details" — and
 * both this route and the client's `niceErr` pass a message through verbatim, so that sentence was
 * rendered to a user who cannot catch anything. Elio screenshotted it.
 *
 * ⛔ And nobody ever DID call getLogs(), so the one detail the error points at was discarded on
 * every failure. `send` now reads it, logs it, and returns one of these sentences.
 */
export function swapError(e) {
  const m = `${e?.message || ''} ${JSON.stringify(e?.logs || [])}`;
  if (/AccountNotFound|could not find account|no record of a prior credit|insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(m)) {
    return 'This wallet has no SOL, so it cannot pay the network fee — and Solana charges that fee in'
      + ' SOL even when the swap is how you were going to get some. Send about 0.0025 SOL to the'
      + ' wallet first and this will go straight through. Nothing was charged.';
  }
  if (/BlockhashNotFound|block height exceeded|blockhash/i.test(m)) {
    return 'The quote expired while it waited to be signed — Solana only holds one for about a minute,'
      + ' because prices move. Press Swap again to take a fresh one. Nothing was charged.';
  }
  if (/0x1771|SlippageToleranceExceeded|slippage/i.test(m)) {
    return 'The price moved past the slippage allowance while the swap was in flight. This pair is'
      + ' thin — try again, or trade a smaller amount. Nothing was charged.';
  }
  if (/insufficient funds|InsufficientFunds/i.test(m)) {
    return 'There is not enough of that token in the wallet to cover this swap. Nothing was charged.';
  }
  if (/already (been )?processed|AlreadyProcessed/i.test(m)) {
    return 'That swap has already been submitted — check the wallet before sending it again.';
  }
  return 'Solana refused the swap and nothing was charged. Trying again in a few seconds usually'
    + ' clears it; if it keeps happening this pair may have no usable route right now.';
}

/** The wallet signs; we broadcast — to MAINNET, whatever cluster the rest of the site is on. */
export async function send(signedB64) {
  const raw = Buffer.from(String(signedB64 || ''), 'base64');
  if (!raw.length || raw.length > 1500) throw new Error('bad transaction');
  try {
    return await conn().sendRawTransaction(raw, { maxRetries: 3, skipPreflight: false });
  } catch (e) {
    // ⛔ READ THE LOGS THE ERROR IS POINTING AT, which is the whole reason it asks to be caught.
    // Without this every failure collapses to "simulation failed" and the cause is unrecoverable
    // afterwards — the node does not keep it, and the user has already closed the page.
    let logs = e?.logs || null;
    if (!logs && typeof e?.getLogs === 'function') {
      try { logs = await e.getLogs(conn()); } catch { /* the node may no longer hold them */ }
    }
    // ⛔ THE REASON IS NOT IN THE PROSE. Elio's screenshot reads "Message: Transaction simulation
    // failed" and then stops — no cause, `Logs: []`. The cause lives in the RPC's STRUCTURED err,
    // which SendTransactionError does not carry, so matching on the message alone lands every
    // preflight failure in the generic branch. Re-simulating costs one call on the failure path and
    // returns `err` as the node reported it ("AccountNotFound"), which is what gets translated.
    let err = null;
    try {
      const sim = await conn().simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: false, replaceRecentBlockhash: true });
      err = sim?.value?.err ?? null;
      if (!logs && sim?.value?.logs?.length) logs = sim.value.logs;
    } catch { /* a re-simulate is a courtesy, never a second failure */ }
    warn('jup send', e?.message || 'failed', 'err=' + JSON.stringify(err),
      logs ? JSON.stringify(logs).slice(0, 800) : '(no logs)');
    throw new Error(swapError({ message: `${e?.message || ''} ${JSON.stringify(err)}`, logs }));
  }
}

/** The token picker's list. Verified only — the same reason the ALTS pairs came from it. */
let _tokens = { at: 0, list: [] };
/** Metadata for a mint the list does not carry, so a pasted address is still selectable. */
export async function tokenInfo(mint) {
  if (!MINT.test(String(mint || ''))) throw new Error('bad mint');
  const known = (await tokens()).find((t) => t.mint === mint);
  if (known) return known;
  try {
    const r = await fetch(`${TOKEN_API}/search?query=${mint}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const t = (Array.isArray(j) ? j : j.tokens || []).find((x) => (x.id || x.address) === mint);
    if (t) return { mint, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon || t.logoURI || null, usd: Number(t.usdPrice ?? 0) || 0, liq: Number(t.liquidity ?? 0) || 0 };
  } catch (e) { warn('jup token', e.message); }
  // Unknown to Jupiter's index but still a mint: read its decimals off chain so amounts are right.
  const info = await conn().getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const dec = info.value?.data?.parsed?.info?.decimals;
  if (dec == null) throw new Error('that mint does not exist on mainnet');
  return { mint, symbol: mint.slice(0, 4) + '…', name: 'Unverified token', decimals: dec, icon: null, usd: 0, liq: 0, unverified: true };
}

export async function tokens() {
  if (Date.now() - _tokens.at < 30 * 60_000 && _tokens.list.length) return _tokens.list;
  try {
    const r = await fetch(`${TOKEN_API}/tag?query=verified`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const arr = (Array.isArray(j) ? j : j.tokens || []).map((t) => ({
      mint: t.id || t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon || t.logoURI || null,
      usd: Number(t.usdPrice ?? t.price ?? 0) || 0,
      liq: Number(t.liquidity ?? 0) || 0,
    })).filter((t) => t.mint && t.symbol);
    arr.sort((a, b) => b.liq - a.liq);
    const list = arr.slice(0, 400);
    // $REX is not deep enough to be in the top of that list, and a swap page on the REX launchpad
    // that cannot find $REX is the one thing it must not do. Put it at the front, from the list if it
    // is there at all, otherwise as a minimal entry so the picker can still select it.
    if (cfg.rexCa) {
      const i = list.findIndex((t) => t.mint === cfg.rexCa);
      const rex = i >= 0 ? list.splice(i, 1)[0]
        : (arr.find((t) => t.mint === cfg.rexCa) || { mint: cfg.rexCa, symbol: 'REX', name: 'REX', decimals: 6, icon: null, usd: 0, liq: 0 });
      list.unshift(rex);
    }
    _tokens = { at: Date.now(), list };
  } catch (e) { warn('jup tokens', e.message); }
  return _tokens.list;
}
