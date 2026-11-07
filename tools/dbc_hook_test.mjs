// ⛔ CAN A HEAVILY-EXTENDED TOKEN-2022 MINT BE A DBC QUOTE?
//
// Every xStock (AAPLx, TSLAx, NVDAx, GLDx …) carries SEVEN Token-2022 extensions — transferHook,
// permanentDelegate, pausableConfig, defaultAccountState, confidentialTransferMint,
// scaledUiAmountConfig, metadataPointer — plus a freeze authority.
//
// The DBC SDK says a TokenBadge is "Required ... when the quote mint is not permissionless-supported
// (for example Token-2022 mints with extra extensions)". $REX passed because it carries only
// metadata extensions. xStocks are the opposite case, and REX Chain ALREADY offers five of them as
// quote assets — so if this fails, those pairs are a promise the chain will refuse, and nobody has
// found out yet because nobody has launched against one.
//
// This builds a devnet mint with xStock-like extensions and tries it for real.
//
//   node tools/dbc_hook_test.mjs
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction, createInitializePermanentDelegateInstruction,
  createInitializeDefaultAccountStateInstruction, AccountState, getMintLen, LENGTH_SIZE, TYPE_SIZE,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';
import fs from 'node:fs';

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));
process.env.FEE_CLAIMER = payer.publicKey.toBase58();
process.env.RPC_URL = 'https://api.devnet.solana.com';

console.log('Can an xStock-shaped quote mint be used on Meteora DBC?');
console.log('payer', payer.publicKey.toBase58(), '\n');

// A mint with the extensions an xStock carries that DBC might object to, plus a freeze authority.
const kp = Keypair.generate();
const meta = { mint: kp.publicKey, name: 'Fake Stock', symbol: 'FAKEx', uri: '', additionalMetadata: [] };
const exts = [ExtensionType.MetadataPointer, ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState];
const mintLen = getMintLen(exts);
const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);

const tx = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeMetadataPointerInstruction(kp.publicKey, payer.publicKey, kp.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializePermanentDelegateInstruction(kp.publicKey, payer.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeDefaultAccountStateInstruction(kp.publicKey, AccountState.Initialized, TOKEN_2022_PROGRAM_ID),
  // freeze authority set, exactly as an xStock has
  createInitializeMintInstruction(kp.publicKey, 8, payer.publicKey, payer.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: kp.publicKey, metadata: kp.publicKey,
    name: meta.name, symbol: meta.symbol, uri: meta.uri, mintAuthority: payer.publicKey, updateAuthority: payer.publicKey }),
);
await sendAndConfirmTransaction(conn, tx, [payer, kp], { commitment: 'confirmed' });
console.log('✅ built an xStock-shaped quote mint (permanentDelegate + defaultAccountState + freeze)');
console.log('   ', kp.publicKey.toBase58(), '\n');

const MET = await import('../lib/meteora.mjs');
const SDK = await import('@meteora-ag/dynamic-bonding-curve-sdk');
const badge = SDK.deriveTokenBadgeAddress(kp.publicKey);
console.log('token badge exists for it:', (await conn.getAccountInfo(badge)) ? 'yes' : 'no (testing permissionless path)');

try {
  const r = await MET.buildLaunch({
    conn, creator: payer.publicKey.toBase58(), quoteMint: kp.publicKey.toBase58(),
    name: 'Hook Test', symbol: 'HT', poolFeeBps: 200, creatorSharePct: 50,
    initialMarketCap: 5000, migrationMarketCap: 50000, quoteDecimals: 8,
  });
  for (const st of r.steps) await sendAndConfirmTransaction(conn, st.tx, [payer, ...st.signers], { commitment: 'confirmed' });
  console.log('\n✅✅ ACCEPTED — an xStock-shaped quote works on DBC with no badge.');
  console.log('   pool', r.pool);
} catch (e) {
  const m = String(e.message || e);
  const code = (m.match(/Error Message: ([^.']+)/) || [])[1] || m.slice(0, 140);
  console.log('\n❌ REFUSED —', code);
  console.log('\n=> xStock-quoted launches would FAIL ON CHAIN after the user signs.');
  console.log('   REX Chain already offers NVDAx, SPCXx, CRCLx, SPYx and GOOGLx as quote assets.');
}
