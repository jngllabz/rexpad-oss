// Paying out what REX Chain has collected — the half of the money path that did not exist.
//
// ⛔ WHY THIS FILE EXISTS. Fees were claimed from every Meteora pool into the fee-claimer wallet
// and then only RECORDED as divided: `applySplit` adds to `rex_pot`/`yield_pool` and moves nothing,
// `runEpoch` writes `payouts` rows and moves nothing, and `CH.distribute()` — the on-chain
// waterfall — had no callers at all. The result was 2,120,399 REX sitting in one wallet, exactly
// the sum of every claim ever made, with neither the protocol wallets nor a single holder having
// received anything. Elio: "they are receiving no income." He was right.
//
// Two rails, both plain SPL transfers signed by the fee claimer, because that is where the money
// actually is:
//   protocol — `rex_pot` across every launch, split across the waterfall legs the CHAIN names
//   holder   — unpaid `payouts` rows, claimed by the holder they belong to
//
// ⛔ THE ORDER IS THE WHOLE DESIGN, and it is the same one the fee crank uses:
//
//     reserve in the database  ->  sign  ->  RECORD the signature  ->  send  ->  settle
//
// The reservation and the signature are written before anything is broadcast, so a crash can never
// leave money paid but unrecorded. The reverse order — pay first, mark after — is what lets a
// restart pay the same holder twice, and no amount of retry logic makes that recoverable. A send
// that fails is put back from `payout_items`, which is why every send itemises what it drained
// rather than recomputing it later from balances that have since moved.
import { PublicKey, Transaction, Keypair, SystemProgram } from '@solana/web3.js';
import { createTransferCheckedInstruction, createTransferCheckedWithFeeInstruction,
         createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
         getAssociatedTokenAddressSync, getMint, getTransferFeeConfig, getEpochFee,
         calculateFee, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { cfg, log, warn } from './config.mjs';
import { db, tx } from './db.mjs';
import { usdOf } from './prices.mjs';

const DUST_USD = 0.25;   // below this a signature costs more than it moves

function signer() {
  if (!cfg.feeClaimerKey) return null;
  try { return Keypair.fromSecretKey(bs58.decode(cfg.feeClaimerKey)); } catch { return null; }
}
export const canPay = () => !!signer();

// ⛔ DECIMALS COME FROM THE MINT, AND FROM NOWHERE ELSE. The first draft of this file converted
// amounts to base units with the QUOTES table's decimals and then handed the transfer the mint's
// own, which is two sources for one number — and they only have to disagree once to send 1000x the
// intended amount. The same mistake, with the same factor, had already been made in applySplit.
const raw = (ui, dec) => BigInt(Math.floor(Number(ui) * 10 ** dec));

/* ------------------------------------------------------------------ what is owed */

/**
 * The protocol's own un-paid income, grouped by the asset it was collected in.
 * `rex_pot` is REX Chain's share of each launch's fees; the other pots belong to the launch itself
 * (its vault, its burn, its buyback) and are not ours to send.
 */
export function protocolDue() {
  const rows = db.prepare(`SELECT mint, symbol, quote, quote_mint, rex_pot FROM tokens
                           WHERE rex_pot > 0 AND quote_mint IS NOT NULL`).all();
  const byQuote = new Map();
  for (const r of rows) {
    const k = r.quote_mint;
    if (!byQuote.has(k)) byQuote.set(k, { quoteMint: k, quote: r.quote, total: 0, items: [] });
    const g = byQuote.get(k);
    g.total += Number(r.rex_pot) || 0;
    g.items.push({ mint: r.mint, symbol: r.symbol, amount: Number(r.rex_pot) || 0 });
  }
  return [...byQuote.values()];
}

/**
 * What EVERY OTHER bucket is owed in one quote asset, in UI units.
 *
 * ⛔ THE FEE CLAIMER'S BALANCE BACKS ALL THE BUCKETS, NOT JUST THE PROTOCOL'S. A claimed fee is
 * divided five ways in the database and the tokens all sit in one wallet, so "what is held" is NOT
 * what the protocol may spend. STNKOG proved it on 9 Oct: the wallet held 0.802 STONK, of which the
 * protocol's share was 0.004 and the creator's 97% share was 0.778 — and the distribution sent the
 * whole 0.802 to the six protocol legs. It took the creator's money and the holders' money and paid
 * it to the treasury, and every figure in the transaction was internally consistent while it did.
 *
 * So the spendable amount is `held MINUS this`. Unclaimed holder rows count — a holder who presses
 * claim tomorrow has a prior call on those tokens.
 */
export function otherBucketsDue(quoteMint) {
  const t = db.prepare(`SELECT COALESCE(SUM(yield_pool),0) + COALESCE(SUM(burn_pot),0)
                             + COALESCE(SUM(buyback_pot),0) + COALESCE(SUM(vault_pot),0)
                             + COALESCE(SUM(creator_pot),0) AS owed
                        FROM tokens WHERE quote_mint = ?`).get(quoteMint)?.owed || 0;
  // ⛔ BY THE ROW'S OWN ASSET. A basket coin quoted in REX can owe its holders DOGE, and counting
  // that against REX would both overstate what REX must cover and leave the DOGE owed invisible.
  const h = db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS owed FROM payouts p
                        JOIN tokens t ON t.mint = p.mint
                        WHERE COALESCE(p.asset_mint, t.quote_mint) = ? AND p.claim_sig IS NULL AND p.amount > 0`).get(quoteMint)?.owed || 0;
  return Number(t) + Number(h);
}

/**
 * What the protocol is sitting on, in dollars, and how long it has been sitting.
 *
 * ⛔ THIS KEEPS HAPPENING, AND IT KEEPS HAPPENING SILENTLY. Elio found 2.12M REX of claimed fees
 * that had never been distributed; the rails were built, one distribution was run by hand on 5 Oct,
 * and by the 7th another ~$433 across seven assets had piled up behind it — because `payProtocol`
 * only runs when a person runs it. There is no alarm, nothing on the site, and nothing in the logs:
 * fees accrue, the pot grows, and the first anyone hears of it is a team member asking why their
 * wallet is not moving.
 *
 * A number that nobody is told is a number nobody acts on, so it goes in /api/health and into a
 * warning on a timer. Deliberately NOT a send: moving the treasury stays a decision, taken either
 * by running the tool or by setting PAYOUT_AUTO=1.
 */
export function protocolPending() {
  const groups = protocolDue();
  let usd = 0;
  const assets = groups.map((g) => {
    const u = g.total * (usdOf(g.quote) || 0);
    usd += u;
    return { quote: g.quote, total: g.total, usd, launches: g.items.length };
  }).sort((a, b) => b.usd - a.usd);
  const lastSend = db.prepare("SELECT MAX(created_at) m FROM payout_sends WHERE kind='protocol'").get()?.m || null;
  return { usd, assets, lastSendAt: lastSend, sinceMs: lastSend ? Date.now() - Number(lastSend) : null };
}

/** One holder's unpaid payout rows, grouped by the asset they are owed in. */
export function holderDue(wallet) {
  // ⛔ A ROW'S ASSET IS ITS OWN, NOT ITS TOKEN'S QUOTE. A coin with a payout basket pays its
  // holders in several assets at once, so one epoch writes one row per asset and each carries the
  // asset it is denominated in. COALESCE keeps every row written before baskets existed — and
  // every coin that still pays in its quote — reading exactly as it did: asset_mint IS NULL means
  // "the token's quote", not "no asset".
  //
  // The guard below has to follow the same resolution. Requiring `t.quote_mint IS NOT NULL` alone
  // would drop a basket row whose own mint is perfectly good merely because its token's quote has
  // not been indexed yet — silently, and the holder would simply never be paid it.
  const rows = db.prepare(`SELECT p.id, p.mint, p.amount, p.epoch, t.symbol,
      COALESCE(p.asset, t.quote) AS quote,
      COALESCE(p.asset_mint, t.quote_mint) AS quote_mint
    FROM payouts p JOIN tokens t ON t.mint = p.mint
    WHERE p.wallet = ? AND p.claim_sig IS NULL AND p.amount > 0
      AND COALESCE(p.asset_mint, t.quote_mint) IS NOT NULL
    ORDER BY p.ts ASC`).all(wallet);
  const byQuote = new Map();
  for (const r of rows) {
    const k = r.quote_mint;
    if (!byQuote.has(k)) byQuote.set(k, { quoteMint: k, quote: r.quote, total: 0, rows: [] });
    const g = byQuote.get(k);
    g.total += Number(r.amount) || 0;
    g.rows.push(r);
  }
  return [...byQuote.values()];
}

/**
 * What the fee claimer actually holds of an asset, in raw units.
 *
 * ⛔ IT MUST COUNT EXACTLY WHAT THE SEND PATH CAN SPEND, or the cap built on it lies in one
 * direction or the other. For native SOL that is lamports PLUS any standing wSOL, because
 * sendTransfers closes the wSOL account in the same transaction and so can spend it; counting
 * lamports alone would refuse to send money the claimer demonstrably has. The token program is
 * resolved through the SAME `CH` the sender uses — two resolvers for one mint is how a Token-2022
 * quote ends up read at one address and sent from another.
 */
async function heldRaw(conn, CH, quoteMint, owner) {
  const ownerPk = new PublicKey(owner);
  const prog = await CH.tokenProgramOf(quoteMint);
  if (isNative(quoteMint)) {
    let lamports = BigInt(await conn.getBalance(ownerPk, 'confirmed'));
    const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, ownerPk, true, prog);
    try {
      if (await conn.getAccountInfo(wrapped)) {
        const bal = await conn.getTokenAccountBalance(wrapped);
        lamports += BigInt(bal?.value?.amount || '0');
      }
    } catch { /* no wSOL account is the normal case, not an error */ }
    return lamports;
  }
  const ata = getAssociatedTokenAddressSync(new PublicKey(quoteMint), ownerPk, true, prog);
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info) return 0n;                       // no account means no balance, which is a real answer
  return BigInt(info.data.readBigUInt64LE(64));   // SPL token account: amount at offset 64
}

/* ------------------------------------------------------------------ sending */

/**
 * Build, sign, record and send one transfer of `amountRaw` of `quoteMint` to each destination.
 *
 * Returns the signature. The caller has ALREADY reserved whatever this drains, inside the same
 * database transaction that wrote the items — this function's only job is to get it on chain and
 * report honestly whether it landed.
 */
/**
 * ⛔ A SOL PAIR'S QUOTE MINT IS **WRAPPED** SOL, AND NOBODY HOLDS WRAPPED SOL.
 *
 * wSOL exists for the few seconds inside a swap that wraps and unwraps it; no account keeps a
 * standing balance of it. So the fee claimer holds 3.36 NATIVE SOL and has no wSOL token account
 * at all — and a TransferChecked whose source is a token account that was never created fails with
 * "invalid account data for instruction", which says nothing about what is actually wrong.
 *
 * That is exactly what happened on the first real distribution: six assets paid, and the SOL leg —
 * $315, the largest of them — came back with that error. It is the same trap that read every
 * SOL-quoted launcher's balance as zero on 5 Oct: the READ side was taught about native SOL and
 * the SEND side never was.
 *
 * Native SOL moves with a system transfer. No token program, no ATA to create, and it lands as
 * spendable SOL rather than as a wrapped balance each recipient would have to unwrap themselves.
 */
const isNative = (mint) => String(mint) === NATIVE_MINT.toBase58();

/**
 * What each recipient ACTUALLY received, read back off the confirmed transaction.
 *
 * ⛔ WHY THIS CANNOT BE ASSUMED FROM WHAT WAS SENT. A Token-2022 transfer fee is deducted in
 * flight: the instruction moves 100, the recipient's balance rises by 97, and the transaction
 * succeeds. GP, ZCAT and MASK take 3%, SI takes 1%. Stamping `paid_at` on a confirmed signature
 * alone therefore recorded a full payment for an amount that was never delivered — the same shape
 * as "Paid so far" once counting allocations nothing had sent.
 *
 * Returns a Map of recipient address -> raw units delivered, or NULL when the transaction could
 * not be read back. ⛔ NULL AND AN EMPTY MAP MEAN DIFFERENT THINGS: null is "I do not know", which
 * must not be written down as zero, and the caller keeps the old behaviour in that case.
 */
async function deliveredByDest(conn, sig, quoteMint) {
  let t = null;
  for (let i = 0; i < 3 && !t; i++) {
    try { t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); }
    catch { /* an RPC that is not ready yet is not an answer; try again */ }
    if (!t) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (!t?.meta) return null;
  const got = new Map();

  if (isNative(quoteMint)) {
    // Native SOL: lamports by account index, which needs the message's own key list.
    const msg = t.transaction?.message;
    const keys = msg?.staticAccountKeys || msg?.accountKeys;
    const pre = t.meta.preBalances, post = t.meta.postBalances;
    if (!keys || !pre || !post) return null;
    for (let i = 0; i < keys.length && i < pre.length && i < post.length; i++) {
      const d = BigInt(post[i]) - BigInt(pre[i]);
      if (d > 0n) got.set(String(keys[i]), d);
    }
    return got;
  }

  // SPL / Token-2022: the post-minus-pre delta on the recipient's token account is the delivered
  // amount with any transfer fee already taken out, which is precisely the number wanted.
  const pre = t.meta.preTokenBalances || [], post = t.meta.postTokenBalances || [];
  if (!post.length) return null;
  const before = new Map();
  for (const b of pre) if (b.mint === quoteMint && b.owner) before.set(b.owner, BigInt(b.uiTokenAmount.amount));
  for (const b of post) {
    if (b.mint !== quoteMint || !b.owner) continue;
    const d = BigInt(b.uiTokenAmount.amount) - (before.get(b.owner) ?? 0n);
    if (d > 0n) got.set(b.owner, d);
  }
  return got;
}

/**
 * Mark a landed send as paid, recording what each row actually delivered rather than what it asked
 * for. A row whose transaction cannot be read back keeps the old behaviour — paid_at set, delivered
 * left NULL — because "I could not check" is not "nothing arrived".
 */
async function settleLanded(conn, sig, quoteMint, dec) {
  db.prepare('UPDATE payout_sends SET settled_at=? WHERE sig=?').run(Date.now(), sig);
  const now = Date.now();
  let got = null;
  try { got = await deliveredByDest(conn, sig, quoteMint); }
  catch (e) { warn('payout read-back', sig.slice(0, 16), e.message); }

  if (!got) {
    db.prepare('UPDATE payouts SET paid_at=? WHERE claim_sig=?').run(now, sig);
    warn('⛔ payout', sig.slice(0, 16), '— could not read the transaction back, so `delivered` is unknown, not zero');
    return;
  }

  // One leg pays one wallet, but a wallet can have many rows behind that leg, so the delivered
  // total is apportioned across them by their share of what was asked.
  const rows = db.prepare('SELECT id, wallet, amount FROM payouts WHERE claim_sig=?').all(sig);
  const asked = new Map();
  for (const r of rows) asked.set(r.wallet, (asked.get(r.wallet) || 0) + (Number(r.amount) || 0));
  const upd = db.prepare('UPDATE payouts SET paid_at=?, delivered=? WHERE id=?');
  let shortfall = 0, total = 0;
  tx(() => {
    for (const r of rows) {
      const wantedAll = asked.get(r.wallet) || 0;
      const landed = Number(got.get(r.wallet) ?? 0n) / 10 ** dec;
      const share = wantedAll > 0 ? (Number(r.amount) || 0) / wantedAll : 0;
      const mine = landed * share;
      upd.run(now, mine, r.id);
      total += Number(r.amount) || 0;
      if (mine + 1e-12 < (Number(r.amount) || 0)) shortfall += (Number(r.amount) || 0) - mine;
    }
  });
  if (shortfall > 0 && total > 0) {
    log(`⚠️  payout ${sig.slice(0, 16)}… delivered ${(total - shortfall).toFixed(6)} of ${total.toFixed(6)} `
      + `(${((shortfall / total) * 100).toFixed(2)}% withheld in transit — a transfer fee on this asset, recorded as delivered)`);
  }
}

/**
 * ⛔ EXPORTED ONLY TO BE TESTED, because the path it guards cannot be reached from a test any other
 * way and has no mainnet mileage: no coin in production has a payout basket yet, so a leg whose
 * asset differs from its coin's quote has never actually settled. The risk this makes testable is
 * a settle that resolves the COIN'S quote instead of the ROW'S asset — it would read the wrong
 * mint's balance delta and divide by the wrong decimals, and both wrongs look like a plausible
 * number rather than a crash.
 */
export const __settleLandedForTest = (conn, sig, quoteMint, dec) => settleLanded(conn, sig, quoteMint, dec);

/**
 * ⛔ EXPORTED ONLY TO BE TESTED, for the same reason `__settleLandedForTest` is: what this builds
 * cannot be read back from anywhere else. A payout to a transfer-fee mint sends one number and
 * delivers another, and the only place the difference exists is in the instruction this assembles
 * — so a test that cannot see the instruction cannot tell a working gross-up from none at all.
 */
export const __sendTransfersForTest = (args) => sendTransfers(args);

async function sendTransfers({ conn, CH, quoteMint, legs, kind, reserve, dec }) {
  const sk = signer();
  if (!sk) throw new Error('no FEE_CLAIMER_KEY — nothing can be sent');
  if (!Number.isFinite(dec)) throw new Error('decimals not resolved before sending');
  const native = isNative(quoteMint);
  const txn = new Transaction();

  if (native) {
    const owed = legs.reduce((a, l) => a + BigInt(l.amountRaw), 0n);
    // Any wSOL the claimer IS holding is the same asset and belongs in the same pot, so it is
    // unwrapped into the native balance in this very transaction rather than left stranded.
    const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, sk.publicKey, true, await CH.tokenProgramOf(quoteMint));
    let wrappedLamports = 0n;
    try {
      const info = await conn.getAccountInfo(wrapped);
      if (info) {
        const bal = await conn.getTokenAccountBalance(wrapped);
        wrappedLamports = BigInt(bal?.value?.amount || '0');
        txn.add(createCloseAccountInstruction(wrapped, sk.publicKey, sk.publicKey));
      }
    } catch { /* no wSOL account is the normal case, not an error */ }

    // ⛔ THE PAYER IS ALSO THE FEE PAYER AND HAS TO STAY RENT-EXEMPT. Draining it to the lamport
    // would strand every future payout behind a wallet that cannot pay for its own transaction.
    const RESERVE = 10_000_000n;                 // 0.01 SOL: rent exemption plus a long run of fees
    const balance = BigInt(await conn.getBalance(sk.publicKey, 'confirmed')) + wrappedLamports;
    if (balance < owed + RESERVE) {
      throw new Error(`the fee claimer holds ${Number(balance) / 1e9} SOL and this needs `
        + `${Number(owed) / 1e9} plus ${Number(RESERVE) / 1e9} kept back for fees — fund ${sk.publicKey.toBase58()}`);
    }
    for (const leg of legs) {
      txn.add(SystemProgram.transfer({ fromPubkey: sk.publicKey, toPubkey: new PublicKey(leg.dest), lamports: BigInt(leg.amountRaw) }));
    }
  } else {
    const prog = await CH.tokenProgramOf(quoteMint);
    const mintPk = new PublicKey(quoteMint);
    const from = getAssociatedTokenAddressSync(mintPk, sk.publicKey, true, prog);
    const fee = await transferFeeOf(conn, CH, quoteMint);

    // ⛔ THE LEG SAYS WHAT WAS PROMISED, NOT WHAT TO SEND. On a transfer-fee mint those are two
    // different numbers, and sending the promise delivers less than it. Every leg is worked back
    // from its arrival: the extra comes out of the claimer's balance, never out of the reward.
    const sends = legs.map((leg) => {
      const owed = BigInt(leg.amountRaw);
      const gross = fee ? fee.grossFor(owed) : owed;
      return { leg, owed, gross, cut: fee ? fee.feeFor(gross) : 0n };
    });

    // ⛔ AND THAT MAKES THE BALANCE A PRECONDITION RATHER THAN A SURPRISE. Short by the fee alone
    // is enough to fail the whole transaction on chain, after the network fee has been paid and
    // with nothing in the message to say the shortfall was 3%.
    const needed = sends.reduce((a, x) => a + x.gross, 0n);
    let held;
    try { held = await heldRaw(conn, CH, quoteMint, sk.publicKey); }
    catch (e) { throw new Error(`could not read the fee claimer's balance of this asset: ${e.message}`); }
    if (held < needed) {
      const ui = (v) => Number(v) / 10 ** dec;
      const owedAll = sends.reduce((a, x) => a + x.owed, 0n);
      throw new Error(fee
        ? `the fee claimer holds ${ui(held)} and this needs ${ui(needed)} — ${ui(owedAll)} owed plus`
          + ` ${ui(needed - owedAll)} to cover the ${fee.bps / 100}% this token charges on every transfer,`
          + ` so that every holder receives what they were promised. Fund ${sk.publicKey.toBase58()} and it goes straight through.`
        : `the fee claimer holds ${ui(held)} and this needs ${ui(needed)} — fund ${sk.publicKey.toBase58()}`);
    }

    for (const x of sends) {
      const dest = new PublicKey(x.leg.dest);
      const to = getAssociatedTokenAddressSync(mintPk, dest, true, prog);
      // Idempotent: costs nothing when the account exists, and without it the FIRST payout to any
      // wallet fails with AccountNotInitialized.
      txn.add(createAssociatedTokenAccountIdempotentInstruction(sk.publicKey, to, dest, mintPk, prog));
      // ⛔ THE ...WithFee FORM ASSERTS THE FEE IT WAS BUILT WITH. A plain transferChecked lets the
      // program take whatever the mint says today, so a rate changed since the read above would
      // underpay in silence. This fails the transaction instead, and the row stays unclaimed.
      txn.add(fee
        ? createTransferCheckedWithFeeInstruction(from, mintPk, to, sk.publicKey, x.gross, dec, x.cut, [], prog)
        : createTransferCheckedInstruction(from, mintPk, to, sk.publicKey, x.gross, dec, [], prog));
    }
    if (fee) {
      const extra = sends.reduce((a, x) => a + (x.gross - x.owed), 0n);
      log(`   ${kind}: +${Number(extra) / 10 ** dec} covers this token's ${fee.bps / 100}% transfer fee`
        + ` across ${sends.length} leg(s), so what lands is what was promised`);
    }
  }
  txn.feePayer = sk.publicKey;
  txn.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  txn.sign(sk);
  const sig = bs58.encode(txn.signature);

  // ⛔ RECORDED BEFORE IT IS BROADCAST. From here on the signature is the only thing that matters:
  // if the process dies on the next line, the reconciler can ask the chain what happened to it.
  tx(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO payout_sends(sig,kind,dest,quote_mint,amount,leg,created_at)
                            VALUES(?,?,?,?,?,?,?)`);
    for (const leg of legs) ins.run(sig, kind, leg.dest, quoteMint, String(leg.amountRaw), leg.key || null, Date.now());
    reserve(sig);
  });

  try {
    await conn.sendRawTransaction(txn.serialize(), { skipPreflight: false, maxRetries: 5 });
    await conn.confirmTransaction(sig, 'confirmed');
    await settleLanded(conn, sig, quoteMint, dec);
    log(`💸 ${kind} payout ${sig.slice(0, 16)}… ${legs.length} leg(s)`);
    return { sig, ok: true };
  } catch (e) {
    // ⛔ A SEND THAT DID NOT LAND MUST GIVE THE MONEY BACK, and only after the chain is sure. A
    // dropped blockhash and a landed-but-unconfirmed transaction look identical from here, so this
    // asks before it restores: putting back money that actually moved would pay it out twice.
    const landed = await didLand(conn, sig);
    if (landed) {
      // Same settlement as the happy path: a transfer that landed after a timeout still delivered
      // whatever it delivered, and recording it as paid-in-full here would reopen the hole.
      await settleLanded(conn, sig, quoteMint, dec);
      return { sig, ok: true };
    }
    unreserve(sig, String(e.message).slice(0, 180));
    return { sig, ok: false, error: String(e.message).slice(0, 200) };
  }
}

/** Did this signature land, as the chain sees it? null-safe: unknown is treated as NOT landed. */
async function didLand(conn, sig) {
  for (let i = 0; i < 3; i++) {
    try {
      const st = await conn.getSignatureStatuses([sig]);
      const v = st?.value?.[0];
      if (v && !v.err && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) return true;
      if (v && v.err) return false;
    } catch { /* fall through to retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** Put back everything a failed send had reserved, exactly as it was recorded. */
function unreserve(sig, note) {
  tx(() => {
    for (const it of db.prepare('SELECT * FROM payout_items WHERE sig=?').all(sig)) {
      if (it.source === 'rex_pot') {
        db.prepare('UPDATE tokens SET rex_pot = rex_pot + ?, rex_paid = rex_paid - ? WHERE mint=?')
          .run(it.amount, it.amount, it.ref);
      } else if (it.source === 'payout') {
        db.prepare('UPDATE payouts SET claim_sig=NULL WHERE id=? AND claim_sig=?').run(Number(it.ref), sig);
      }
    }
    db.prepare('UPDATE payout_sends SET failed_at=?, note=? WHERE sig=?').run(Date.now(), note, sig);
  });
  warn('payout', `send ${sig.slice(0, 16)}… did not land — reserved amounts restored: ${note}`);
}

/**
 * What this mint takes out of a transfer on the way to the recipient, or null if it takes nothing.
 *
 * ⛔ A TRANSFER-FEE TOKEN DOES NOT DELIVER WHAT YOU SEND. Token-2022's TransferFee extension
 * withholds a percentage inside the transfer itself, so `transfer(100)` credits the recipient 97
 * and parks 3 on their own account as withheld fee. Pay a holder their 100 and they receive 97 —
 * every epoch, for ever, in units small enough to read as dust rather than as a bug. That is why
 * these assets were refused as payout assets at all until this existed.
 *
 * So the amount is worked BACKWARDS from what was promised: `grossFor(owed)` is the smallest
 * amount whose arrival is at least `owed`, and the extra comes out of the fee claimer's balance
 * rather than out of the holder's reward.
 *
 * ⛔ READ FROM THE MINT, AND NOT FOR LONG. The fee is MUTABLE — $SANTA's `transferFeeConfigAuthority`
 * is live, so the rate can be changed under us — and it is epoch-scheduled, which is why the
 * extension carries an older and a newer rate and why the epoch has to be asked for rather than
 * assumed. A number copied into the quotes table would be a second source for a figure that
 * decides what a holder receives; the table's `transferFeeBps` is there to DESCRIBE the asset to a
 * creator, never to size a transfer. Sixty seconds of cache keeps one payout pass to one read,
 * and the instruction below asserts the fee it was built with, so a stale read fails the whole
 * transaction instead of quietly underpaying somebody.
 */
/**
 * The arithmetic on its own, given one epoch's resolved rate — separated from the chain read so it
 * can be checked against `calculateFee` over the whole range, cap and all, without a validator.
 */
export function feeMath(tf, what = 'this token') {
  const bps = Number(tf.transferFeeBasisPoints) || 0;
  if (bps <= 0) return null;
  if (bps >= 10_000) throw new Error(`${what} takes 100% of every transfer — no amount of it can reach a holder`);
  const feeFor = (amount) => (amount > 0n ? calculateFee(tf, amount) : 0n);
  return {
    bps,
    maximumFee: tf.maximumFee,
    feeFor,
    netFor: (gross) => (gross > 0n ? gross - feeFor(gross) : gross),
    grossFor(owed) {
      if (owed <= 0n) return owed;
      const b = BigInt(bps);
      // The uncapped rate, rounded UP: rounding down is how the recipient ends a unit short.
      let gross = (owed * 10_000n + (10_000n - b) - 1n) / (10_000n - b);
      // Past the cap the fee stops growing, so owed + the cap always arrives whole and is the
      // cheaper answer for a large transfer.
      const capped = owed + tf.maximumFee;
      if (capped < gross) gross = capped;
      // ⛔ CHECKED AGAINST THE PROGRAM'S OWN ARITHMETIC, NEVER ASSUMED. The fee rounds up and the
      // cap interacts with that rounding; a formula that is right for every case I thought of is
      // still a formula nobody asked the program about.
      for (let i = 0; i < 4 && gross - feeFor(gross) < owed; i++) gross += 1n;
      if (gross - feeFor(gross) < owed) throw new Error(`could not work out an amount of ${what} that arrives whole`);
      return gross;
    },
  };
}

const FEE_TTL_MS = 60_000;
const _fee = new Map();
export async function transferFeeOf(conn, CH, mint) {
  const hit = _fee.get(mint);
  if (hit && Date.now() - hit.at < FEE_TTL_MS) return hit.fee;
  let fee = null;
  const prog = await CH.tokenProgramOf(mint);
  if (prog.equals(TOKEN_2022_PROGRAM_ID)) {
    const m = await getMint(conn, new PublicKey(mint), 'confirmed', prog);
    const conf = getTransferFeeConfig(m);
    if (conf) {
      // ⛔ THE EPOCH HAS TO BE ASKED FOR. A fee change is scheduled, not immediate, which is why
      // the extension carries an older rate and a newer one — `getEpochFee` picks the one in force.
      const epoch = BigInt((await conn.getEpochInfo()).epoch);
      fee = feeMath(getEpochFee(conf, epoch), mint);
    }
  }
  _fee.set(mint, { at: Date.now(), fee });
  return fee;
}

/** Decimals straight from the mint, never a table: a wrong one is a 1000x. */
const _dec = new Map();
async function decimalsOnChain(conn, mint) {
  if (_dec.has(mint)) return _dec.get(mint);
  const info = await conn.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const d = info?.value?.data?.parsed?.info?.decimals;
  if (!Number.isFinite(d)) throw new Error(`could not read decimals for ${mint}`);
  _dec.set(mint, d);
  return d;
}

/* ------------------------------------------------------------------ the two rails */

/**
 * Pay the protocol's own income out across the waterfall legs the chain config names.
 * With `execute: false` it reads and signs nothing, which is what the dry run does.
 */
export async function payProtocol({ conn, CH, execute = false } = {}) {
  const out = { quotes: 0, sent: 0, skipped: 0, failed: 0, legs: [], sigs: [], error: null };
  // ⛔ waterfall() RETURNS AN OBJECT, { legs, totalBps, authority, paused } — not an array. Checking
  // `wf?.length` on it is always undefined, so this reported "the config names no waterfall legs"
  // against a config that names six of them totalling 10000 bps, and refused to pay anything. The
  // tests did not catch it because the stub returned an array: a stub that is kinder than the real
  // thing tests the stub. It now mirrors this shape.
  const wfRes = await CH.waterfall();
  const wf = (wfRes?.legs || []).map((l) => ({ ...l, wallet: l.wallet?.toBase58?.() ?? String(l.wallet) }));
  if (!wf.length) { out.error = 'the chain config names no waterfall legs — nothing can be split'; return out; }
  const totalBps = wf.reduce((a, l) => a + Number(l.bps || 0), 0);
  if (totalBps <= 0) { out.error = 'every waterfall leg is 0 bps'; return out; }

  for (const g of protocolDue()) {
    out.quotes++;
    const usd = g.total * (usdOf(g.quote) || 0);
    if (usd < DUST_USD) { out.skipped++; continue; }
    let dec; try { dec = await decimalsOnChain(conn, g.quoteMint); }
    catch (e) { out.failed++; warn('payout protocol', e.message); continue; }
    let totalRaw = raw(g.total, dec);

    // ⛔ THE LEDGER SAYS WHAT WE ARE OWED. THE WALLET SAYS WHAT WE CAN SEND. THEY ARE NOT THE SAME.
    //
    // `rex_pot` is credited from trades as we observe them, but the tokens only become ours when
    // the fee is CLAIMED off the Meteora pool — a separate crank, with its own failure modes. When
    // the pot runs ahead of the claims, this tried to send money that is not there and the whole
    // transfer failed at simulation with "insufficient funds".
    //
    // Measured on mainnet: the pot said 156.45 STONK, the fee claimer held 0.80, and the
    // distribution had failed NINE times over two days — six legs each, 48 dead transactions,
    // every one paying a fee to accomplish nothing. And because the asset fails as a whole, the
    // 0.80 STONK we DO hold never went out either.
    //
    // So the amount is capped at the balance. Paying out what we actually have beats paying out
    // nothing, the rest stays in the pot for when the claim lands, and the shortfall is said out
    // loud rather than discovered in a simulation log.
    let held = 0n;
    try { held = await heldRaw(conn, CH, g.quoteMint, signer().publicKey); }
    catch (e) { out.failed++; warn('payout protocol', `cannot read the ${g.quote} balance: ${e.message}`); continue; }
    let fee = null;
    try { fee = await transferFeeOf(conn, CH, g.quoteMint); }
    catch (e) { out.failed++; warn('payout protocol', `cannot read the ${g.quote} transfer fee: ${e.message}`); continue; }
    // ⛔ WHAT IS HELD IS NOT WHAT THE PROTOCOL MAY SPEND. One wallet holds the tokens behind all
    // five buckets, so the other four have a prior call on it — including unclaimed holder rows.
    //
    // ⛔ AND ON A TRANSFER-FEE QUOTE THAT PRIOR CALL IS BIGGER THAN IT LOOKS. `otherBucketsDue`
    // answers in PROMISES, and a promise of 100 costs the claimer 103.1 to keep — so reserving the
    // promise lets this rail spend 3% of what the holders are owed, every pass, and the shortfall
    // only turns up later as a holder payout that cannot be funded.
    const reservedUi = otherBucketsDue(g.quoteMint);
    const reserved = fee ? fee.grossFor(raw(reservedUi, dec)) : raw(reservedUi, dec);
    const spendable = held > reserved ? held - reserved : 0n;
    // ⛔ AND WHAT IS SPENDABLE IS STILL NOT WHAT ARRIVES. `netFor` is what the whole spendable
    // balance would deliver; the leg count comes off it because each leg is rounded up on its own,
    // so N legs can need up to N raw units more than one transfer of the sum would. Capping at the
    // balance and then grossing up past it is a transaction that fails.
    let affordable = spendable;
    if (fee && spendable > 0n) { const n = fee.netFor(spendable) - BigInt(wf.length); affordable = n > 0n ? n : 0n; }
    if (affordable < totalRaw) {
      if (affordable === 0n) {
        warn('payout protocol', reservedUi > 0
          ? `⛔ ${g.quote}: the pot says ${g.total} and the fee claimer holds ${Number(held) / 10 ** dec},`
            + ` but ${reservedUi} of that is owed to holders, the creator, burn and vault.`
            + ' Nothing sent; the pot is untouched until more fee is claimed.'
          : `⛔ ${g.quote}: the pot says ${g.total} but the fee claimer holds NONE —`
            + ' the trading fee has not been claimed off the pool yet. Nothing sent; the pot is untouched.');
        out.skipped++; continue;
      }
      warn('payout protocol', `⛔ ${g.quote}: the pot says ${g.total}; the claimer holds`,
        `${Number(held) / 10 ** dec} of which ${reservedUi} is reserved for the other buckets, so`,
        `${Number(affordable) / 10 ** dec} can be delivered${affordable === spendable ? '' : ' once this token\'s transfer fee is covered'}.`,
        'Sending that; the rest waits for the fee claim.');
      totalRaw = affordable;
    }
    // ⛔ Largest-remainder, so the legs always sum to EXACTLY what was drained. Rounding each leg
    // independently leaves dust stranded in a wallet nobody is watching, every single time.
    let left = totalRaw;
    const legs = wf.map((l, i) => {
      const amt = i === wf.length - 1 ? left : (totalRaw * BigInt(Math.round(l.bps))) / BigInt(totalBps);
      left -= amt;
      return { key: l.key, dest: l.wallet, amountRaw: amt, label: l.label, bps: l.bps };
    }).filter((l) => l.amountRaw > 0n);
    if (!legs.length) { out.skipped++; continue; }
    out.legs.push({ quote: g.quote, total: g.total, usd, legs: legs.map((l) => ({ ...l, amountRaw: String(l.amountRaw) })) });
    if (!execute) continue;

    // ⛔ DRAIN ONLY WHAT WENT OUT. When the balance capped the transfer, the pot must keep the
    // difference — debiting the full figure would quietly write off income we never sent.
    const sentFrac = g.total > 0 ? Number(totalRaw) / Number(raw(g.total, dec)) : 1;
    const reserve = (sig) => {
      for (const it of g.items) {
        const part = it.amount * sentFrac;
        db.prepare('UPDATE tokens SET rex_pot = rex_pot - ?, rex_paid = rex_paid + ? WHERE mint=?')
          .run(part, part, it.mint);
        db.prepare('INSERT OR IGNORE INTO payout_items(sig,source,ref,amount) VALUES(?,?,?,?)')
          .run(sig, 'rex_pot', it.mint, part);
      }
    };
    try {
      const r = await sendTransfers({ conn, CH, quoteMint: g.quoteMint, legs, kind: 'protocol', reserve, dec });
      out.sigs.push({ quote: g.quote, sig: r.sig, ok: r.ok, error: r.error || null });
      r.ok ? out.sent++ : out.failed++;
    } catch (e) { out.failed++; warn('payout protocol', e.message); }
  }
  return out;
}

/**
 * Pay one holder everything they are owed, in one transfer per asset.
 * The rows are stamped with the signature INSIDE the same transaction that signs it, so two
 * simultaneous claims cannot both take the same row.
 */
export async function payHolder({ conn, CH, wallet, execute = false } = {}) {
  const out = { wallet, sent: 0, skipped: 0, failed: 0, groups: [], error: null };
  const due = holderDue(wallet);
  if (!due.length) { out.error = 'nothing owed'; return out; }

  for (const g of due) {
    const usd = g.total * (usdOf(g.quote) || 0);
    out.groups.push({ quote: g.quote, total: g.total, usd, rows: g.rows.length });
    if (usd < DUST_USD) { out.skipped++; continue; }
    if (!execute) continue;
    let dec; try { dec = await decimalsOnChain(conn, g.quoteMint); }
    catch (e) { out.failed++; warn('payout holder', e.message); continue; }
    const legs = [{ key: null, dest: wallet, amountRaw: raw(g.total, dec) }];
    const reserve = (sig) => {
      for (const r of g.rows) {
        // Conditional on claim_sig still being NULL: whoever gets there first owns the row.
        const n = db.prepare('UPDATE payouts SET claim_sig=? WHERE id=? AND claim_sig IS NULL').run(sig, r.id).changes;
        if (n) db.prepare('INSERT OR IGNORE INTO payout_items(sig,source,ref,amount) VALUES(?,?,?,?)')
                 .run(sig, 'payout', String(r.id), Number(r.amount) || 0);
      }
    };
    try {
      const r = await sendTransfers({ conn, CH, quoteMint: g.quoteMint, legs, kind: 'holder', reserve, dec });
      r.ok ? out.sent++ : out.failed++;
    } catch (e) { out.failed++; warn('payout holder', e.message); }
  }
  return out;
}

/**
 * Pay EVERY holder who is owed something, not just one who asks.
 *
 * ⛔ 307 PAYOUT ROWS, 85,301 OF VALUE, AND NOT ONE HAD EVER BEEN SENT. `runEpoch` allocates a
 * holder's reward and writes the row; `payHolder` sends it — and nothing ever called payHolder.
 * PAYOUT_AUTO ran the protocol waterfall only, and no screen in the product offered a holder a
 * way to claim, so the rows simply accumulated. Meanwhile `yield_paid` was incremented at
 * allocation time and shown as "Paid so far", which is how a holder comes to read that they have
 * been paid thousands of REX they never received. Elio: "the computer says that it already paid
 * but i didn't receive any rex on my wallet."
 *
 * Pull-based rewards nobody can pull are not rewards. This pays them.
 */
export async function payAllHolders({ conn, CH, execute = false, maxWallets = 40 } = {}) {
  const out = { wallets: 0, sent: 0, skipped: 0, failed: 0, usd: 0, error: null };
  if (!signer()) { out.error = 'no FEE_CLAIMER_KEY — nothing can be sent'; return out; }
  // Biggest first: if a pass is cut short by the cap or an RPC wobble, the money that matters most
  // has already moved, and the tail comes round on the next one.
  //
  // ⛔ BIGGEST IN DOLLARS, NOT IN RAW UNITS. `ORDER BY SUM(amount)` adds REX to SOL as though one
  // of each were the same thing, so 15,674 REX (worth $2.98) outranked 0.0736 SOL (worth $15.45)
  // and every SOL-owed wallet fell outside the per-pass cap. $15 of holder rewards sat unsent
  // behind $3 of them. Sorting money by a number whose unit varies per row is the same mistake as
  // pricing a curve in "50,000" without saying of what.
  // ⛔ AND THE UNIT IS THE ROW'S OWN ASSET, not its token's quote — which is the same mistake one
  // layer along. A basket row denominated in DOGE priced as though it were REX would put this
  // wallet in the wrong place in exactly the ordering the comment above exists to protect.
  const rows = db.prepare(`SELECT p.wallet, COALESCE(p.asset, t.quote) AS quote, COUNT(*) n, SUM(p.amount) amt
    FROM payouts p JOIN tokens t ON t.mint = p.mint
    WHERE p.claim_sig IS NULL AND p.amount > 0 AND COALESCE(p.asset_mint, t.quote_mint) IS NOT NULL
    GROUP BY p.wallet, COALESCE(p.asset, t.quote)`).all();
  const byWallet = new Map();
  for (const r of rows) {
    const usd = Number(r.amt) * (usdOf(r.quote) || 0);
    const g = byWallet.get(r.wallet) || { wallet: r.wallet, usd: 0, rows: 0 };
    g.usd += usd; g.rows += r.n;
    byWallet.set(r.wallet, g);
  }
  const owed = [...byWallet.values()].sort((a, b) => b.usd - a.usd);
  for (const w of owed.slice(0, maxWallets)) {
    out.wallets++;
    try {
      const r = await payHolder({ conn, CH, wallet: w.wallet, execute });
      out.sent += r.sent; out.skipped += r.skipped; out.failed += r.failed;
      out.usd += r.groups.reduce((a, g) => a + (g.usd || 0), 0);
    } catch (e) { out.failed++; warn('payout holders', `${w.wallet.slice(0, 8)}…: ${e.message}`); }
  }
  out.remaining = Math.max(0, owed.length - out.wallets);
  return out;
}

/**
 * What holders have ACTUALLY been sent for a coin, and what is still waiting.
 *
 * ⛔ `yield_paid` IS AN ALLOCATION FIGURE, NOT A PAYMENT ONE. It is incremented when an epoch
 * decides who gets what; the transfer happens later, or — until now — never. Presenting it as
 * "Paid so far" told holders they had received money that was still sitting in the fee claimer.
 */
export function holderTotals(mint) {
  const r = db.prepare(`SELECT
      -- WHAT LANDED, NOT WHAT WAS ASKED FOR. A fee-bearing asset delivers less than the row says,
      -- so summing amount reported holders as paid more than they received. COALESCE to amount
      -- rather than 0: NULL means a row that settled before delivered existed, or one whose
      -- transaction could not be read back -- neither of which is "nothing arrived".
      COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN COALESCE(delivered, amount) END), 0) AS paid,
      COALESCE(SUM(CASE WHEN claim_sig IS NULL THEN amount END), 0)   AS waiting,
      COUNT(CASE WHEN paid_at IS NOT NULL THEN 1 END)                 AS paidRows
    FROM payouts WHERE mint = ?`).get(mint) || {};
  return { paid: Number(r.paid) || 0, waiting: Number(r.waiting) || 0, paidRows: Number(r.paidRows) || 0 };
}

/**
 * Anything signed but never resolved — a crash between recording and confirming. Asks the chain,
 * then either settles it or puts the money back. Safe to run on a timer and at startup.
 */
export async function reconcile({ conn } = {}) {
  const open = db.prepare('SELECT DISTINCT sig FROM payout_sends WHERE settled_at IS NULL AND failed_at IS NULL').all();
  let settled = 0, restored = 0;
  for (const { sig } of open) {
    const landed = await didLand(conn, sig);
    if (landed) {
      // ⛔ THE RECONCILER SETTLES THE SAME WAY THE SENDER DOES, or a crash between signing and
      // confirming would be the one route that still records a fee-bearing transfer as paid in
      // full. It has to resolve the asset itself: the sender had `quoteMint` and `dec` in hand,
      // this only has the signature, and payout_sends is where that mapping was written down.
      const row = db.prepare('SELECT quote_mint FROM payout_sends WHERE sig=? LIMIT 1').get(sig);
      let dec = null;
      if (row?.quote_mint) { try { dec = await decimalsOnChain(conn, row.quote_mint); } catch { /* fall through */ } }
      if (row?.quote_mint && Number.isFinite(dec)) {
        await settleLanded(conn, sig, row.quote_mint, dec);
      } else {
        db.prepare('UPDATE payout_sends SET settled_at=? WHERE sig=?').run(Date.now(), sig);
        db.prepare('UPDATE payouts SET paid_at=? WHERE claim_sig=?').run(Date.now(), sig);
        warn('⛔ reconcile', sig.slice(0, 16), '— settled without a read-back: asset or decimals unresolved, so `delivered` stays NULL');
      }
      settled++;
    } else {
      unreserve(sig, 'unresolved at reconcile');
      restored++;
    }
  }
  return { open: open.length, settled, restored };
}

/** What has actually been paid, for the ledger. */
export const sends = (limit = 100) => db.prepare(
  `SELECT sig,kind,dest,quote_mint,amount,leg,created_at,settled_at,failed_at,note
   FROM payout_sends ORDER BY created_at DESC LIMIT ?`).all(limit);

/**
 * Put back protocol income that was marked paid but never sent.
 *
 * ⛔ WHY THIS IS NEEDED. `settleRex` in the engine zeroed `rex_pot` into `rex_paid` on every epoch
 * and booked the amount as burned and bought back. It is a PAPER settlement — it moves nothing —
 * and until it was gated to SIM it ran on mainnet too, so 2,093,861 REX was recorded as distributed
 * while every token of it still sat in the fee claimer. The money is not lost; the bookkeeping is
 * simply ahead of it.
 *
 * This only ever moves `rex_paid` back to `rex_pot` for amounts with NO corresponding send on the
 * record, so it cannot resurrect anything that really was paid out. It is a correction to a ledger,
 * not a transfer, and it is a dry run unless asked otherwise.
 */
export function recreditUnsent({ execute = false } = {}) {
  // Anything genuinely sent has rows in payout_sends; this is what was not.
  const sent = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payout_items WHERE source='rex_pot'").get()?.s || 0;
  const rows = db.prepare('SELECT mint, symbol, rex_paid, rex_pot FROM tokens WHERE rex_paid > 0').all();
  const out = { sentOnRecord: sent, items: [], total: 0, executed: execute };
  for (const r of rows) {
    const item = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payout_items WHERE source='rex_pot' AND ref=?").get(r.mint)?.s || 0;
    const unsent = Math.max(0, (Number(r.rex_paid) || 0) - item);
    if (unsent <= 0) continue;
    out.items.push({ mint: r.mint, symbol: r.symbol, rexPaid: r.rex_paid, sent: item, unsent });
    out.total += unsent;
    if (execute) {
      db.prepare('UPDATE tokens SET rex_pot = rex_pot + ?, rex_paid = rex_paid - ? WHERE mint=?').run(unsent, unsent, r.mint);
    }
  }
  if (execute && out.total > 0) log(`↩️  recredited ${out.total.toFixed(6)} of protocol income that was marked paid but never sent`);
  return out;
}
