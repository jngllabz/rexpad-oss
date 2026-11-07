// Does the transfer hook actually stop a transfer? On real devnet, against the real token program.
//
// The whole claim of this feature is "a trade that breaks your rule never lands". That is either
// true or it is marketing, and the only way to know is to try to break a rule and watch the
// transaction fail. So this creates a Token-2022 mint carrying the hook, sets a wallet cap, then
// makes two transfers: one under the cap, and one that would cross it.
//
//   RPC_URL=https://api.devnet.solana.com node tools/devnet_hook.mjs
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, createInitializeMintInstruction,
  createInitializeTransferHookInstruction, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync, getAccount,
  createTransferCheckedWithTransferHookInstruction,
} from '@solana/spl-token';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const RPC = process.env.RPC_URL || 'https://api.devnet.solana.com';
const HOOK = new PublicKey(process.env.HOOK_PROGRAM || '9YnrpwYYhzKAqz25PncsafkGptc2CZUJsFZRcN5G1hrB');
const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + '/.config/solana/id.json', 'utf8'))));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅', m); } else { fail++; console.log('❌', m); } };
/** Anchor's instruction discriminator: the first 8 bytes of sha256("global:<name>"). */
const disc = (name) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

const DEC = 6, UNIT = 10 ** DEC;
const CAP = 1000 * UNIT;          // nobody may hold more than 1,000 tokens

console.log(`payer ${payer.publicKey.toBase58()}  ${(await conn.getBalance(payer.publicKey)) / LAMPORTS_PER_SOL} SOL`);
console.log(`hook  ${HOOK.toBase58()}\n`);

// ---------------------------------------------------------------- 1. a mint that carries the hook
const mintKp = Keypair.generate();
const mint = mintKp.publicKey;
const rules = PublicKey.findProgramAddressSync([Buffer.from('rules'), mint.toBuffer()], HOOK)[0];
const metas = PublicKey.findProgramAddressSync([Buffer.from('extra-account-metas'), mint.toBuffer()], HOOK)[0];

// The extension has to be written while the mint is being created — this ordering is not a style
// choice, it is the only moment a transfer hook can ever be attached to a token.
const len = getMintLen([ExtensionType.TransferHook]);
await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: mint, space: len,
    lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID,
  }),
  createInitializeTransferHookInstruction(mint, payer.publicKey, HOOK, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint, DEC, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
), [payer, mintKp], { commitment: 'confirmed' });
console.log('1. mint with transfer hook:', mint.toBase58());

// ---------------------------------------------------------------- 2. the rules
await sendAndConfirmTransaction(conn, new Transaction().add({
  programId: HOOK,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },   // payer
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },  // authority
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: rules, isSigner: false, isWritable: true },
    { pubkey: metas, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([disc('initialize'), u64(CAP), i64(0), u64(0)]),
}), [payer], { commitment: 'confirmed' });
console.log(`2. rules written: max wallet ${CAP / UNIT} tokens`);

// ---------------------------------------------------------------- 3. two wallets, funded
const alice = payer, bob = Keypair.generate();
const aAta = getAssociatedTokenAddressSync(mint, alice.publicKey, false, TOKEN_2022_PROGRAM_ID);
const bAta = getAssociatedTokenAddressSync(mint, bob.publicKey, false, TOKEN_2022_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, aAta, alice.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, bAta, bob.publicKey, mint, TOKEN_2022_PROGRAM_ID),
  createMintToInstruction(mint, aAta, payer.publicKey, 10_000 * UNIT, [], TOKEN_2022_PROGRAM_ID),
), [payer], { commitment: 'confirmed' });
console.log('3. alice holds 10,000; bob holds 0\n');

const send = async (amount) => {
  const ix = await createTransferCheckedWithTransferHookInstruction(
    conn, aAta, mint, bAta, alice.publicKey, BigInt(amount), DEC, [], 'confirmed', TOKEN_2022_PROGRAM_ID,
  );
  return sendAndConfirmTransaction(conn, new Transaction().add(ix), [alice], { commitment: 'confirmed' });
};

// ---------------------------------------------------------------- 4. under the cap: must land
try {
  const sig = await send(900 * UNIT);
  const bal = Number((await getAccount(conn, bAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount) / UNIT;
  ok(bal === 900, `H1 a transfer UNDER the cap lands — bob holds ${bal}  ${sig.slice(0, 10)}…`);
} catch (e) { ok(false, 'H1 a transfer under the cap lands — ' + e.message.slice(0, 120)); }

// ---------------------------------------------------------------- 5. over the cap: must NOT land
// This is the whole feature. Not reversed afterwards, not flagged — refused by the chain.
let landed = false, why = '';
try { await send(200 * UNIT); landed = true; }
catch (e) { why = String(e.message || e); }
ok(!landed, 'H2 a transfer that would cross the cap is REFUSED by the chain');
// It must fail for the RIGHT reason. An earlier run "passed" this while the hook was not being
// reached at all — every transfer was dying on a discriminator mismatch, so a refused transfer
// proved nothing. 0x1772 is OverWalletCap; 0x65 is Anchor saying it never found the instruction.
if (!landed) {
  ok(!/0x65\b/.test(why), 'H3 and NOT because the hook was never reached (0x65 would mean it was not)');
  ok(/0x1772|OverWalletCap|maximum holding/i.test(why),
    `H3b specifically on the wallet cap — ${(why.match(/0x[0-9a-f]+|OverWalletCap/i) || ['?'])[0]}`);
}

const after = Number((await getAccount(conn, bAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount) / UNIT;
ok(after === 900, `H4 bob's balance is unchanged at ${after} — the refused transfer moved nothing`);

// ---------------------------------------------------------------- 6. the rule can only loosen
const relax = (cap) => sendAndConfirmTransaction(conn, new Transaction().add({
  programId: HOOK,
  keys: [{ pubkey: rules, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }],
  data: Buffer.concat([disc('relax'), u64(cap), Buffer.from([0])]),
}), [payer], { commitment: 'confirmed' });

let tightened = false;
try { await relax(500 * UNIT); tightened = true; } catch {}
ok(!tightened, 'H5 the authority CANNOT tighten the cap on people who already bought');

try {
  await relax(5000 * UNIT);
  await send(200 * UNIT);
  const bal = Number((await getAccount(conn, bAta, 'confirmed', TOKEN_2022_PROGRAM_ID)).amount) / UNIT;
  ok(bal === 1100, `H6 after loosening to 5,000 the same transfer lands — bob holds ${bal}`);
} catch (e) { ok(false, 'H6 loosening lets it through — ' + String(e.message).slice(0, 120)); }

console.log(`\n${pass} passed, ${fail} failed`);
console.log('mint https://solscan.io/token/' + mint.toBase58() + '?cluster=devnet');
process.exit(fail ? 1 : 0);
