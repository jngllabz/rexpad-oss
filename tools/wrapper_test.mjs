// ⛔ ONE CLOSE, NOT TWO — AND NOT ZERO EITHER.
//
// A SOL-quoted creator claim carried two CloseAccount instructions: the Meteora SDK builds its own
// wrapped-SOL handling, and we appended ours around it. The second close acted on the account the
// first had just closed, so the token program answered InvalidAccountData and the launcher saw
//
//   "Error processing Instruction 6: invalid account data for instruction. Logs: [ Program
//    dbcij3LWUpp… success, … Program Tokenkeg… failed: invalid account data for instruction ]"
//
// A launcher photographed that on 10 Oct. Simulating every pool with fees accrued found 8 failing
// the same way — every SOL-quoted pool whose creator held enough SOL to reach the close.
//
// Days earlier the bug was the EXACT OPPOSITE: a close with nothing to open it. Hard-coding either
// answer is how this oscillates, so the code asks the instructions and this file pins that down.
//
//   node tools/claim_wrapper_test.mjs
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
         getAssociatedTokenAddressSync, createCloseAccountInstruction,
         createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };

const CH = await import('../lib/chain.mjs');
const MET = await import('../lib/meteora.mjs');

const USER = '4o9txL3vZUR6UHCeb5AntbZJhryXLtMWzAdPoucG1bj4';
const REX = 'CmQJNJ185pfkJpcHBqNsJmzEcnJLGzLGgFJcBQdQoxiz';
const WSOL = NATIVE_MINT.toBase58();
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(USER), true, TOKEN_PROGRAM_ID);
const close = () => createCloseAccountInstruction(wsolAta, new PublicKey(USER), new PublicKey(USER));
const open = () => createAssociatedTokenAccountIdempotentInstruction(
  new PublicKey(USER), wsolAta, new PublicKey(USER), NATIVE_MINT, TOKEN_PROGRAM_ID);
const dbc = () => ({ programId: new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'), keys: [], data: Buffer.alloc(8) });
const closes = (ixs) => ixs.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data?.length === 1 && i.data[0] === 9).length;

console.log('── the SDK already opens and closes the wrapper: add neither');
{
  const inner = [open(), open(), dbc(), close()];
  const { prefix, suffix } = MET.wrapperAround(CH, inner, WSOL, USER);
  ok(prefix.length === 0, 'no second open');
  ok(suffix.length === 0, '⛔ no second close — this is the InvalidAccountData the launcher photographed');
  ok(closes([...prefix, ...inner, ...suffix]) === 1, 'exactly one CloseAccount in the whole transaction');
}

console.log('\n── the SDK closes but does not open: add the open only');
{
  const inner = [dbc(), close()];
  const { prefix, suffix } = MET.wrapperAround(CH, inner, WSOL, USER);
  ok(prefix.length === 1, 'the open is added');
  ok(suffix.length === 0, 'and no duplicate close');
}

console.log('\n── ⛔ THE OPPOSITE BUG STAYS FIXED: the SDK does neither, so we do both');
{
  // This was the state a few days ago — a close with nothing to open it, which paid wrapped SOL
  // into an account that had never been created and failed with the same words from the other end.
  const inner = [dbc()];
  const { prefix, suffix } = MET.wrapperAround(CH, inner, WSOL, USER);
  ok(prefix.length === 1, 'the open is added');
  ok(suffix.length === 1, 'and the close, so the SOL does not stay wrapped');
  ok(closes([...prefix, ...inner, ...suffix]) === 1, 'still exactly one close');
}

console.log('\n── a close belonging to SOMEONE ELSE is not ours and does not count');
{
  const other = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(REX), true, TOKEN_PROGRAM_ID);
  const theirs = createCloseAccountInstruction(other, new PublicKey(REX), new PublicKey(REX));
  const { suffix } = MET.wrapperAround(CH, [dbc(), theirs], WSOL, USER);
  ok(suffix.length === 1, 'our wrapper is still closed');
}

console.log('\n── a non-native quote never gets a close, whatever the SDK did');
{
  for (const inner of [[dbc()], [open(), dbc()], [dbc(), close()]]) {
    const { suffix } = MET.wrapperAround(CH, inner, REX, USER);
    ok(suffix.length === 0, `no unwrap for a REX-quoted claim (${inner.length} inner ix)`);
  }
}

console.log('\n── a system-program instruction is never mistaken for a close');
{
  const pay = SystemProgram.transfer({ fromPubkey: new PublicKey(USER), toPubkey: wsolAta, lamports: 1 });
  const { suffix } = MET.wrapperAround(CH, [pay, dbc()], WSOL, USER);
  ok(suffix.length === 1, 'the close is still added — a transfer is not a close');
}

console.log('\n── and the launcher is told what is wrong in words');
{
  // ⛔ A REAL, DESERIALISABLE TRANSACTION. A made-up base64 string throws in the deserialiser and
  // explainBeforeSending answers null from its catch — so the stub is never reached and every
  // assertion below passes while proving nothing. (That is what this block did on its first run.)
  const { Transaction } = await import('@solana/web3.js');
  const t = new Transaction();
  // Two ATA creates, exactly as a creator claim carries: one for the base, one for the quote.
  t.add(open(), open(), SystemProgram.transfer({ fromPubkey: new PublicKey(USER), toPubkey: wsolAta, lamports: 1 }));
  t.feePayer = new PublicKey(USER);
  t.recentBlockhash = NATIVE_MINT.toBase58();
  const TX = t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  // The figures mainnet actually returns.
  const RENT170 = 1_513_840, FLOOR = 890_880;
  const chain = (over) => ({
    getMinimumBalanceForRentExemption: async (n) => (n === 0 ? FLOOR : RENT170),
    getBalance: async () => 2_990_000,                       // the 0.003 SOL I told them to send
    ...over,
  });

  let reached = 0;
  const fake = (logs, err = { InstructionError: [0, { Custom: 1 }] }) => chain({
    simulateTransaction: async () => { reached++; return { value: { err, logs } }; },
  });
  const rent = await MET.explainBeforeSending(
    fake(['Program 11111111111111111111111111111111 invoke [2]', 'Transfer: insufficient lamports 968605, need 1488440']), TX);
  ok(reached === 1, 'the simulation actually ran — the transaction deserialised');
  // ⛔ THE WHOLE POINT: two rents plus the payer's own floor, NOT the 0.00149 the log mentions.
  // I quoted that single figure to seven launchers; six sent it and were still short.
  ok(/0\.00393/.test(rent || ''), `it states the TOTAL, not the first shortfall — "${rent}"`);
  ok(/opens 2 token accounts/.test(rent || ''), 'and says both accounts are being opened');
  ok(!/0\.00149 SOL\./.test(rent || ''), '⛔ never the one-account figure from the log');
  ok(/Send it 0\.001 SOL more/.test(rent || ''), 'with the top-up they still need');
  ok(rent && !/Custom|InstructionError|Program \w{32}/.test(rent), 'and no program ids or error codes');

  // ⛔ The payer falling below its OWN rent-exempt floor is a different error shape, and used to
  // fall through to the useless generic branch. NYANINU hit exactly this.
  const floor = await MET.explainBeforeSending(
    chain({ simulateTransaction: async () => ({ value: { err: { InsufficientFundsForRent: { account_index: 0 } }, logs: [] } }) }), TX);
  ok(/0\.00393/.test(floor || ''), `InsufficientFundsForRent is the same answer — "${String(floor).slice(0, 60)}…"`);
  ok(!/would fail on chain/.test(floor || ''), 'and not the generic one');

  const bad = await MET.explainBeforeSending(fake(['Program log: Error: InvalidAccountData'],
    { InstructionError: [5, 'InvalidAccountData'] }), TX);
  ok(/nothing has been sent/i.test(bad || ''), `the duplicate-close shape is explained too — "${String(bad).slice(0, 50)}…"`);

  const clean = await MET.explainBeforeSending(
    chain({ simulateTransaction: async () => ({ value: { err: null, logs: [] } }) }), TX);
  ok(clean === null, 'a clean simulation says nothing');

  // ⛔ An RPC we could not reach is not a transaction we know is bad.
  const dead = await MET.explainBeforeSending(chain({ simulateTransaction: async () => { throw new Error('429'); } }), TX);
  ok(dead === null, '⛔ and an unreachable RPC lets the claim through rather than blocking a good one');

  // A wallet with plenty does not get told to top up just because something else failed.
  const rich = await MET.explainBeforeSending(chain({
    getBalance: async () => 5_000_000_000,
    simulateTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 1, need 2'] } }),
  }), TX);
  ok(!/Send it/.test(rich || ''), 'a funded wallet is not told to send itself more SOL');
}

console.log('\n── ⛔ A SWAP: THE SDK DOES THE WHOLE WRAPPED-SOL DANCE, SO WE DO NONE OF IT');
{
  // This is what every SOL-paired buy looked like, and why not one of them could be bought:
  //   0:ATA 1:SYS 2:TOKEN  3:ATA 4:SYS 5:TOKEN  6:DBC  7:TOKEN 8:TOKEN
  //   └──── ours ───────┘  └──── the SDK's ──┘        └ its close, then ours → InvalidAccountData
  const { createSyncNativeInstruction } = await import('@solana/spl-token');
  const fund = () => SystemProgram.transfer({ fromPubkey: new PublicKey(USER), toPubkey: wsolAta, lamports: 1_000_000 });
  const sync = () => createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID);
  const sdkBuy = [open(), fund(), sync(), dbc(), close()];

  const w = MET.sdkWrapper(sdkBuy, USER);
  ok(w.opens && w.funds && w.closes, 'the SDK is seen to open, fund and close the wrapper');

  const r = MET.wrapperForSwap(CH, sdkBuy, WSOL, USER, { amountIn: 1_000_000n, prog: TOKEN_PROGRAM_ID, receivesQuote: false });
  ok(r.pre.length === 0, '⛔ we do not wrap a second time — the buyer needed TWICE the SOL they were spending');
  ok(r.post.length === 0, '⛔ and do not close a second time — this is the InvalidAccountData');
  ok(closes([...r.pre, ...sdkBuy, ...r.post]) === 1, 'exactly one close in the whole buy');
}

console.log('\n── but if the SDK stops doing it, we still do');
{
  const bare = [dbc()];
  const r = MET.wrapperForSwap(CH, bare, WSOL, USER, { amountIn: 1_000_000n, prog: TOKEN_PROGRAM_ID, receivesQuote: false });
  ok(r.pre.length > 0, 'the wrap is added');
  ok(r.post.length === 1, 'and the unwrap, so no SOL is left stranded in a wrapper');
}

console.log('\n── an SDK that opens the account but never funds it is not "ready"');
{
  // Opening an empty wSOL account and calling the buy funded would spend nothing and fail for a
  // reason that looks nothing like the cause.
  const r = MET.wrapperForSwap(CH, [open(), dbc(), close()], WSOL, USER,
    { amountIn: 1_000_000n, prog: TOKEN_PROGRAM_ID, receivesQuote: false });
  ok(r.pre.length > 0, 'we still fund it');
  ok(r.post.length === 0, 'but do not add a second close');
}

console.log('\n── selling only needs the account to exist, never funding');
{
  const r = MET.wrapperForSwap(CH, [open(), dbc(), close()], WSOL, USER,
    { amountIn: 0n, prog: TOKEN_PROGRAM_ID, receivesQuote: true });
  ok(r.pre.length === 0, 'the SDK opened it, so nothing is added');
  ok(r.post.length === 0, 'and it closes it');
  const r2 = MET.wrapperForSwap(CH, [dbc()], WSOL, USER, { amountIn: 0n, prog: TOKEN_PROGRAM_ID, receivesQuote: true });
  ok(r2.pre.length === 1 && r2.post.length === 1, 'and when it does neither, we do both');
}

console.log('\n── a non-native quote is untouched by any of this');
{
  const buy = MET.wrapperForSwap(CH, [dbc()], REX, USER, { amountIn: 5n, prog: TOKEN_PROGRAM_ID, receivesQuote: false });
  ok(buy.post.length === 0, 'no unwrap on a REX-quoted buy');
  ok(buy.pre.length >= 1, 'and the quote account is still made ready');
}

console.log('\n── the price moving mid-trade is explained as that, not as a program error');
{
  const { Transaction } = await import('@solana/web3.js');
  const t2 = new Transaction();
  t2.add(SystemProgram.transfer({ fromPubkey: new PublicKey(USER), toPubkey: wsolAta, lamports: 1 }));
  t2.feePayer = new PublicKey(USER);
  t2.recentBlockhash = NATIVE_MINT.toBase58();
  const TX2 = t2.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const slip = await MET.explainBeforeSending(
    { simulateTransaction: async () => ({ value: { err: { InstructionError: [6, { Custom: 6001 }] },
      logs: ['Program log: Error: ExceededSlippage'] } }) }, TX2, { action: 'buy' });
  ok(/price moved/.test(slip || ''), `"${String(slip).slice(0, 70)}…"`);
  ok(/raise your slippage/.test(slip || ''), 'and it says what to do about it');

  const rent = await MET.explainBeforeSending({
    getMinimumBalanceForRentExemption: async (n) => (n === 0 ? 890_880 : 1_513_840),
    getBalance: async () => 1000,
    simulateTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 1 }] },
      logs: ['Transfer: insufficient lamports 1000, need 2000000'] } }),
  }, TX2, { action: 'buy' });
  ok(/This buy opens/.test(rent || ''), `and a buy is called a buy, not a claim — "${String(rent).slice(0, 40)}…"`);
}

console.log('\n── ⛔ "INSUFFICIENT LIQUIDITY" IS A REFUSAL, NOT AN ANSWER');
{
  // A bonding curve holds a finite amount of base, so a buy past the end of it cannot fill. That
  // is correct — but the SDK says it in two words, and the moment everyone wants in is the moment
  // the curve is thinnest. searchMax finds the size that WOULD work, and must never overshoot:
  // a number that still will not fill is worse than the refusal, because it looks like an answer.
  const upTo = (n) => (x) => x <= n;
  ok(await MET.searchMax(upTo(1000n), 10_000n) === 1000n, 'it finds the exact boundary');
  ok(await MET.searchMax(upTo(1n), 10_000n) === 1n, 'even when only one unit fits');
  ok(await MET.searchMax(upTo(0n), 10_000n) === 0n, '⛔ a finished curve answers 0, not 1');
  ok(await MET.searchMax(upTo(10_000n), 10_000n) === 10_000n, 'and when the whole ask fits, that is the answer');
  ok(await MET.searchMax(upTo(9_999n), 10_000n) === 9_999n, 'including one below the ask');
  ok(await MET.searchMax(upTo(1000n), 0n) === 0n, 'an empty ask is 0');

  // The answer must itself fit — over a thousand random boundaries, never one unit too high.
  let over = 0, wrong = 0;
  for (let i = 0; i < 1000; i++) {
    const b = BigInt(Math.floor(Math.random() * 1e9));
    const u = b + BigInt(Math.floor(Math.random() * 1e9)) + 1n;
    const got = await MET.searchMax(upTo(b), u);
    if (got > b) over++;
    if (got !== b) wrong++;
  }
  ok(over === 0, `⛔ the answer always fits — 0 of 1000 overshot`);
  ok(wrong === 0, `and it is the exact boundary every time (${1000 - wrong}/1000)`);

  // A huge ask must not cost a huge search.
  let calls = 0;
  const counted = (x) => { calls++; return x <= 123_456_789n; };
  ok(await MET.searchMax(counted, 10n ** 18n) === 123_456_789n, 'it handles an 18-digit ask');
  ok(calls < 70, `in ${calls} evaluations, not a scan`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
