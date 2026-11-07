// One signature, every blocked launcher funded.
//
// ⛔ WHY THIS EXISTS. Seven launchers could not claim fees they had already earned, because a claim
// has to OPEN token accounts and their wallets could not cover the rent. The owner funded all seven
// by hand from a list I gave them — and six were still blocked, because the figure I gave was the
// rent for ONE account when a claim opens two and the payer must also stay above its own
// rent-exempt floor. A hand-copied list of addresses and amounts is a thing that goes wrong twice.
//
// So the list is derived here, from the chain, at the moment the button is pressed: who is blocked,
// by exactly how much, in one transaction the owner signs once.
//
// ⛔ IT NEVER GUESSES AN AMOUNT. Every figure is the shortfall computed from the launcher's real
// balance against the real rent, and a wallet that is not short is not in the transaction at all.
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { warn } from './config.mjs';

/** A little over the shortfall, so a lamport of drift does not send everyone back for a third go. */
const HEADROOM = 200_000;              // 0.0002 SOL
/** Nobody is topped up past this, whatever the arithmetic says — a guard on a money-moving button. */
export const MAX_PER_WALLET = 20_000_000;   // 0.02 SOL
/** Solana's own cap is 64; well under it leaves room for the blockhash and signatures. */
export const MAX_PER_TX = 18;

/**
 * Who cannot claim for want of SOL, and what each needs, read live.
 *
 * `rows` are ready to fund. `fine` are launchers with fees waiting who can already claim — listed
 * so the owner can see the button is not simply ignoring them.
 */
/**
 * Run `fn` over `items` a few at a time.
 *
 * ⛔ THIS PLAN IS A LOT OF CHAIN WORK — a pool read for every launch, then a built claim and a
 * simulation for every launcher. Done one at a time it took long enough that the admin panel sat
 * on "Checking who cannot claim…" for ever and the owner reasonably concluded it was broken.
 * Done all at once it would trip the RPC breaker and take the site down with it. A few at a time
 * is the only version that is both quick and survivable.
 */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

export async function topupPlan({ conn, db, MET }) {
  const launches = db.prepare(`SELECT mint, symbol, creator, dbc_pool, quote, quote_mint FROM tokens
                               WHERE venue='dbc' AND dbc_pool IS NOT NULL AND creator IS NOT NULL`).all();
  const [perAccount, floor] = await Promise.all([
    conn.getMinimumBalanceForRentExemption(170),   // a Token-2022 account: the larger of the two
    conn.getMinimumBalanceForRentExemption(0),     // the payer's own floor, which no log mentions
  ]);
  // One entry per launcher, carrying the claim we will actually test them against.
  const withFees = await pooled(launches, 8, async (t) => {
    try {
      const fees = await MET.creatorFeesOf(conn, t.dbc_pool);
      return fees && (fees.quote !== 0n || fees.base !== 0n) ? { t, fees } : null;
    } catch { return null; }
  });
  const byWallet = new Map();
  for (const r of withFees) {
    if (!r) continue;
    const { t, fees } = r;
    const g = byWallet.get(t.creator) || { wallet: t.creator, coins: [], claim: null };
    g.coins.push(t.symbol || t.mint.slice(0, 6));
    if (!g.claim) g.claim = { pool: t.dbc_pool, quoteMint: t.quote_mint, baseMint: t.mint, fees };
    byWallet.set(t.creator, g);
  }

  const rows = [], fine = [];
  await pooled([...byWallet.values()], 4, async (g) => {
    let have = 0;
    try { have = await conn.getBalance(new PublicKey(g.wallet), 'confirmed'); }
    catch (e) { warn('topup', `${g.wallet.slice(0, 8)}…: ${e.message}`); return; }   // unknown ≠ broke

    // ⛔ "I COULD NOT CHECK" IS NOT "IT IS FINE".
    //
    // Simulating the claim is the honest test — I got the arithmetic wrong three times before
    // resorting to it. But explainBeforeSending answers null BOTH for a claim that simulates
    // clean and for one it could not simulate at all, and reading that null as "their claim
    // works" turned five blocked launchers into "nothing to fund" the moment the RPC was under
    // pressure. The owner pressed the button and was told there was nobody to pay, with five
    // names listed on the screen above it.
    //
    // So: a simulation that RAN decides. One that did not falls back to the arithmetic, which
    // errs towards funding — being 0.001 SOL too generous costs a fraction of a cent, and being
    // wrong the other way leaves somebody unable to claim money they have earned.
    let creates = 0, verdict = null;   // true = blocked, false = fine, null = could not tell
    if (g.claim && MET.buildClaimCreatorTx && MET.inspectBeforeSending) {
      try {
        const built = await MET.buildClaimCreatorTx({
          conn, creator: g.wallet, pool: g.claim.pool, quoteMint: g.claim.quoteMint,
          maxBase: g.claim.fees.base, maxQuote: g.claim.fees.quote,
        });
        const r = await MET.inspectBeforeSending(conn, built.tx, { action: 'claim' });
        // Only a SOL shortfall puts them on the list; a claim broken for some other reason is a
        // different problem and funding it would not fix it.
        if (r.checked) verdict = !!r.why && /SOL/.test(r.why);
      } catch (e) { warn('topup', `${g.wallet.slice(0, 8)}… claim unreadable: ${e.message.slice(0, 60)}`); }
    }
    for (const [mint, prog] of await claimAccounts(g, MET, conn)) {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(g.wallet), true, prog);
        if (!(await conn.getAccountInfo(ata, 'confirmed'))) creates++;
      } catch { creates++; }
    }
    if (verdict === false) { g.have = have; g.need = have; g.checked = true; fine.push(g); return; }
    if (verdict === null && creates === 0) creates = 1;   // unknown, and nothing obvious to open
    if (verdict === true && creates === 0) creates = 1;   // it failed for SOL, so something opens
    g.unverified = verdict === null;
    const need = creates * perAccount + floor + 10_000;
    g.have = have; g.need = need; g.creates = creates;
    if (have >= need) { fine.push(g); return; }
    g.send = Math.min(MAX_PER_WALLET, need - have + HEADROOM);
    rows.push(g);
  });
  rows.sort((a, b) => b.send - a.send);
  return { rows, fine, perAccount, floor, total: rows.reduce((s, r) => s + r.send, 0) };
}

/** The (mint, token program) pairs a creator claim pays into: the coin itself and the quote. */
async function claimAccounts(g, MET, conn) {
  const out = [];
  if (!g.claim) return out;
  const prog = async (mint) => {
    try { const { tokenProgramOf } = await import('./chain.mjs'); return await tokenProgramOf(mint); }
    catch { return TOKEN_PROGRAM_ID; }
  };
  for (const mint of [g.claim.baseMint, g.claim.quoteMint]) {
    if (!mint) continue;
    out.push([mint, await prog(mint)]);
  }
  return out;
}

/**
 * One unsigned transaction that funds every wallet in `rows`.
 *
 * ⛔ THE AMOUNTS ARE NOT TAKEN FROM THE CALLER. The browser says "fund them", not "fund this
 * address with this much" — otherwise the button becomes a way to send the owner's SOL anywhere.
 * The caller may only narrow the set by wallet address.
 */
export async function buildTopupTx({ conn, from, rows }) {
  if (!rows.length) throw new Error('nothing to fund');
  if (rows.length > MAX_PER_TX) rows = rows.slice(0, MAX_PER_TX);
  const payer = new PublicKey(from);
  const total = rows.reduce((s, r) => s + r.send, 0);
  const have = await conn.getBalance(payer, 'confirmed');
  const floor = await conn.getMinimumBalanceForRentExemption(0);
  if (have < total + floor + 10_000) {
    throw new Error(`This needs ${(total / 1e9).toFixed(5)} SOL plus fees and your wallet holds `
      + `${(have / 1e9).toFixed(5)}. Top it up, or fund fewer at once.`);
  }
  const tx = new Transaction();
  for (const r of rows) {
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(r.wallet), lamports: r.send }));
  }
  tx.feePayer = payer;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  return { tx, total, count: rows.length };
}
