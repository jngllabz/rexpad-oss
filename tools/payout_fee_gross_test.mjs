// A holder paid in a transfer-fee token must receive what their payout says, to the unit.
//
// ⛔ WHAT THIS IS FOR. Julz asked for $SANTA in the payout basket on 26 Oct; the owner's answer
// was "build the gross-up so santa works". Token-2022's TransferFee extension withholds its cut
// INSIDE the transfer, so `transfer(100)` credits the recipient 97 and parks 3 on their own
// account as withheld fee. Send a holder the amount their row says and they are short 3% — every
// epoch, for ever, in units small enough to read as dust rather than as a bug. That is why these
// assets were refused as payout assets at all until the rail could work backwards from arrival.
//
// ⛔ THE GATE AND THE RAIL ARE ONE CHANGE. `payableAsset` admits a fee-bearing mint only because
// `sendTransfers` covers the fee. Open the gate against a rail that still sends the promise
// verbatim and the original bug is restored exactly, so the last section here holds them together.
//
//   node tools/payout_fee_gross_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

const dir = fs.mkdtempSync(`${os.tmpdir()}/rex-fee-`);
process.env.DATA_DIR = dir;
process.env.DB_NAME = 'fee.sqlite';
process.env.SIM = '1';
// A throwaway claimer, so the rail has a signer. It signs one transaction that is never broadcast:
// the stub below captures the bytes and refuses to send them.
const claimer = Keypair.generate();
process.env.FEE_CLAIMER_KEY = bs58.encode(claimer.secretKey);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const P = await import('../lib/payout.mjs');
const T = await import('@solana/spl-token');
const { payableAsset, QUOTES } = await import('../lib/prices.mjs');

const T22 = T.TOKEN_2022_PROGRAM_ID;
const SPL = T.TOKEN_PROGRAM_ID;

console.log('── the arithmetic, checked against the program that will charge it');
{
  // ⛔ NOT AGAINST A SECOND COPY OF MY OWN FORMULA. `calculateFee` is the spl-token library's own
  // implementation of what the on-chain program does, so it is the only opinion here that counts.
  const rates = [
    { transferFeeBasisPoints: 300, maximumFee: 1_000_000_000_000_000n },   // $SANTA, $GP, $ZCAT, $MASK
    { transferFeeBasisPoints: 100, maximumFee: 1_000_000_000_000_000n },   // $SI, $ALLINU
    { transferFeeBasisPoints: 9_999, maximumFee: 1_000_000_000_000_000n }, // the pathological end
    { transferFeeBasisPoints: 250, maximumFee: 5_000n },                   // ⛔ and one that CAPS
  ];
  let short = 0, wasteful = 0, n = 0;
  for (const tf of rates) {
    const m = P.feeMath(tf, 'T');
    for (let owed = 1n; owed < 2_000_000_000n; owed = owed * 3n + 7n) {
      const gross = m.grossFor(owed);
      n++;
      if (gross - T.calculateFee(tf, gross) < owed) short++;
      // and not a unit more than it has to be — the extra comes out of the pot, not out of the air
      if (gross > 1n && (gross - 1n) - T.calculateFee(tf, gross - 1n) >= owed) wasteful++;
    }
  }
  ok(n > 60, `${n} amounts across ${rates.length} rates, including one that hits its cap`);
  ok(short === 0, '⛔ every one arrives WHOLE — not one leaves the holder short');
  ok(wasteful === 0, 'and every one is minimal: a unit less would arrive short');

  const m3 = P.feeMath(rates[0], 'T');
  // Worked by hand: ceil(1e6 × 10000 / 9700) = 1,030,928; ceil(1,030,928 × 300 / 10000) = 30,928.
  ok(m3.grossFor(1_000_000n) === 1_030_928n, '1.000000 promised → 1.030928 sent, at 3%');
  ok(m3.feeFor(1_030_928n) === 30_928n && 1_030_928n - 30_928n === 1_000_000n, '  · and exactly 1.000000 lands');
  ok(m3.netFor(1_030_928n) === 1_000_000n, 'netFor is the same answer from the other end');
  ok(m3.grossFor(0n) === 0n, 'nothing owed sends nothing');
  ok(P.feeMath({ transferFeeBasisPoints: 0, maximumFee: 0n }) === null,
    '⛔ a mint that charges nothing yields NO fee object — the plain path must stay plain');
  let threw = '';
  try { P.feeMath({ transferFeeBasisPoints: 10_000, maximumFee: 0n }, '$X'); } catch (e) { threw = e.message; }
  ok(/100% of every transfer/.test(threw), 'and a 100% fee is refused in words, not with a divide by zero');
}

/* ------------------------------------------------------------------ the rail itself */

// The real $SANTA mint account, read off mainnet 26 Oct and kept verbatim: Token-2022, 6dp,
// TransferFeeConfig 300 bps from epoch 1036, no mint authority, no freeze authority. Recorded
// rather than fetched so this suite needs no network and cannot drift with the chain's mood.
const SANTA = '3c7mmVSyEH8jfZXgxvpLsETtko1Y16DyRJ5XYB4snhGt';
const SANTA_MINT = Buffer.from(
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwpxO5G2IAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACa2W+9d1pQztnsCyRfNVbLEg55ETiKjxCHJrR2SrUZBAQBsAEAtXK96l8U0l2WOVhsmI9Djj1NA8git1QpO9FQLCssuQC1cr3qXxTSXZY5WGyYj0OOPU0DyCK3VCk70VAsKyy7UF0tCAgAAAAwEAAAAAAAAAIDGpH6NAwAsAQwEAAAAAAAAAIDGpH6NAwAsARMAngAHg6gVJiEPlKDo6E0ghwA7OkJg0pznnaz+IaTqdx+mKCa2W+9d1pQztnsCyRfNVbLEg55ETiKjxCHJrR2SrUZBBQAAAFNBTlRBBQAAAFNBTlRBRAAAAGh0dHBzOi8vZ2F0ZXdheS5pcnlzLnh5ei9ldzRGV2hoNW52cXVSUldQUGg2UUR0dVdZQUJyUkhkSFFGRWRLS05CczQ2AAAAAA==',
  'base64');

/** A token account holding `amount`, which is all `heldRaw` reads out of one (offset 64). */
const tokenAccount = (amount) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return b; };

function harness({ mint, prog, mintAccount = null, held }) {
  let raw = null;
  const conn = {
    async getEpochInfo() { return { epoch: 1068 }; },
    async getAccountInfo(pk) {
      if (pk.toBase58() === mint) return mintAccount && { owner: prog, data: mintAccount, lamports: 1, executable: false, rentEpoch: 0 };
      return { owner: prog, data: tokenAccount(held), lamports: 1, executable: false, rentEpoch: 0 };
    },
    async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }; },
    // ⛔ CAPTURE AND REFUSE. Nothing this suite builds may reach a network, and a send that is
    // recorded then thrown exercises the failure path too: the reservation must come back.
    async sendRawTransaction(bytes) { raw = Buffer.from(bytes); throw new Error('captured, not sent'); },
    async getSignatureStatuses() { return { value: [null] }; },
  };
  return { conn, CH: { tokenProgramOf: async () => prog }, captured: () => raw };
}

const transferIx = (bytes, programId) => Transaction.from(bytes).instructions
  .filter((i) => i.programId.equals(programId)).at(-1);

console.log('\n── what goes out of the claimer, on a mint that charges 3%');
{
  const owed = 1_000_000n, gross = 1_030_928n, cut = 30_928n;
  const h = harness({ mint: SANTA, prog: T22, mintAccount: SANTA_MINT, held: 10_000_000n });
  const dest = Keypair.generate().publicKey.toBase58();
  const r = await P.__sendTransfersForTest({
    conn: h.conn, CH: h.CH, quoteMint: SANTA, dec: 6, kind: 'holder', reserve: () => {},
    legs: [{ key: null, dest, amountRaw: owed }],
  });
  ok(r.ok === false && /captured/.test(r.error || ''), 'the transaction was built, signed and handed to the stub');

  const ix = transferIx(h.captured(), T22);
  const want = T.createTransferCheckedWithFeeInstruction(
    T.getAssociatedTokenAddressSync(new PublicKey(SANTA), claimer.publicKey, true, T22),
    new PublicKey(SANTA),
    T.getAssociatedTokenAddressSync(new PublicKey(SANTA), new PublicKey(dest), true, T22),
    claimer.publicKey, gross, 6, cut, [], T22);
  ok(Buffer.from(ix.data).equals(Buffer.from(want.data)),
    `⛔ it sends ${gross} to deliver the ${owed} that was promised — the gross-up is in the instruction, not in a comment`);
  ok(!Buffer.from(ix.data).equals(Buffer.from(T.createTransferCheckedInstruction(
    want.keys[0].pubkey, new PublicKey(SANTA), want.keys[2].pubkey, claimer.publicKey, owed, 6, [], T22).data)),
    '  · and it is NOT the plain transfer of the promised amount, which is what used to go out');
  // ⛔ The ...WithFee form carries the fee the client expected. A plain transferChecked would let
  // the program take whatever the mint says at landing time, so a rate changed between the read
  // and the block would underpay in silence; this makes that case fail the transaction instead.
  ok(ix.data.length === want.data.length && ix.data[0] === want.data[0],
    '  · built with the form that ASSERTS the fee, so a rate changed under us fails rather than underpays');
}

console.log('\n── and on a mint that charges nothing, nothing changes');
{
  const owed = 1_000_000n;
  const mint = Keypair.generate().publicKey.toBase58();
  const h = harness({ mint, prog: SPL, held: 10_000_000n });
  const dest = Keypair.generate().publicKey.toBase58();
  await P.__sendTransfersForTest({
    conn: h.conn, CH: h.CH, quoteMint: mint, dec: 6, kind: 'holder', reserve: () => {},
    legs: [{ key: null, dest, amountRaw: owed }],
  });
  const ix = transferIx(h.captured(), SPL);
  const want = T.createTransferCheckedInstruction(
    T.getAssociatedTokenAddressSync(new PublicKey(mint), claimer.publicKey, true, SPL),
    new PublicKey(mint),
    T.getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(dest), true, SPL),
    claimer.publicKey, owed, 6, [], SPL);
  ok(Buffer.from(ix.data).equals(Buffer.from(want.data)),
    '⛔ a legacy SPL mint still gets a plain transferChecked of exactly what was owed — the fee path is not a tax on everything else');
}

console.log('\n── short by the fee is short, and it says so before it pays a network fee');
{
  // ⛔ ENOUGH FOR THE PROMISE IS NOT ENOUGH FOR THE TRANSFER. Holding exactly what is owed fails
  // on chain with nothing in the message to say the gap was the token's own 3%.
  const owed = 1_000_000n;
  const h = harness({ mint: SANTA, prog: T22, mintAccount: SANTA_MINT, held: owed });
  let msg = '';
  try {
    await P.__sendTransfersForTest({
      conn: h.conn, CH: h.CH, quoteMint: SANTA, dec: 6, kind: 'holder', reserve: () => {},
      legs: [{ key: null, dest: Keypair.generate().publicKey.toBase58(), amountRaw: owed }],
    });
  } catch (e) { msg = e.message; }
  ok(/3%/.test(msg) && /every transfer/.test(msg), `refused in plain words naming the rate: "${msg.slice(0, 80)}…"`);
  ok(/1\.030928/.test(msg) && /1 owed/.test(msg), '  · with the three numbers that matter: held, needed, and the cover');
  ok(h.captured() === null, '⛔ and NOTHING was signed or sent — the refusal is before the network fee, not after it');
}

console.log('\n── the gate and the rail are one change');
{
  ok(payableAsset('SANTA'), 'SANTA can be paid to a holder, which is what was asked for');
  ok(QUOTES.SANTA?.transferFeeBps === 300, '  · and it is on the books as a 3% mint, for the form to say so');
  const taxed = Object.keys(QUOTES).filter((s) => payableAsset(s) && QUOTES[s].transferFeeBps > 0);
  ok(taxed.length > 0, `${taxed.length} payable assets charge a transfer fee (${taxed.join(', ')})`);
  for (const sym of taxed) {
    const m = P.feeMath({ transferFeeBasisPoints: QUOTES[sym].transferFeeBps, maximumFee: 1_000_000_000_000_000n }, sym);
    ok(m && m.grossFor(1_000_000n) > 1_000_000n, `  · ⛔ ${sym} is grossed up rather than sent at face value`);
  }
  // ⛔ AND THE RAIL IS WHAT ALLOWS THEM, NOT THE OTHER WAY ROUND. If the gross-up is ever taken
  // out, this is the line that should fail first — before a holder quietly receives 97%.
  const src = fs.readFileSync(new URL('../lib/payout.mjs', import.meta.url), 'utf8');
  ok(/createTransferCheckedWithFeeInstruction/.test(src) && /grossFor\(owed\)/.test(src),
    '⛔ sendTransfers still works every leg back from its arrival');

  // The two hazards are not the same hazard: a fee can be covered, an issuer who can reach into
  // the account afterwards cannot be.
  for (const cat of ['stock', 'leverage']) {
    const sym = Object.keys(QUOTES).find((s) => QUOTES[s].category === cat);
    ok(sym && !payableAsset(sym), `${sym} is still refused — covering a fee cannot undo a freeze or a clawback`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
