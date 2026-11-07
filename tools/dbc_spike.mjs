// Can Meteora DBC quote a launch in $REX?
//
// This is the one unknown that decides whether REX Chain can move its curve onto Meteora and be
// indexed from block one. DBC needs a TOKEN BADGE for a quote mint that is "not
// permissionless-supported (for example Token-2022 mints with extra extensions)", and badges are
// created by Meteora, not by us — so if REX needs one, REX-quoted launches are gated on a third
// party and the whole plan changes shape.
//
// REX is Token-2022 but carries ONLY metadataPointer + tokenMetadata. No transfer fee, no hook.
// That should make it ordinary as far as a pool is concerned. "Should" is not evidence, so this
// builds a devnet mint with exactly that shape and actually tries it.
//
//   node tools/dbc_spike.mjs
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction, getMintLen, LENGTH_SIZE, TYPE_SIZE,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';
import fs from 'node:fs';

const RPC = 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))));

console.log('DBC quote-mint spike — devnet');
console.log('payer', payer.publicKey.toBase58());
console.log('balance', ((await conn.getBalance(payer.publicKey)) / 1e9).toFixed(4), 'SOL\n');

// ---- 1. a Token-2022 mint shaped exactly like REX: metadata extensions and nothing else
const mintKp = Keypair.generate();
const meta = { mint: mintKp.publicKey, name: 'Spike REX', symbol: 'SREX', uri: '', additionalMetadata: [] };
const mintLen = getMintLen([ExtensionType.MetadataPointer]);
const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);

const tx = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey,
    space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeMetadataPointerInstruction(mintKp.publicKey, payer.publicKey, mintKp.publicKey, TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mintKp.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mintKp.publicKey,
    metadata: mintKp.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri,
    mintAuthority: payer.publicKey, updateAuthority: payer.publicKey }),
);
const sig = await sendAndConfirmTransaction(conn, tx, [payer, mintKp], { commitment: 'confirmed' });
console.log('✅ REX-shaped Token-2022 quote mint created');
console.log('   mint', mintKp.publicKey.toBase58());
console.log('   sig ', sig.slice(0, 20) + '…\n');

// ---- 2. does DBC accept it as a quote WITHOUT a token badge?
const SDK = await import('@meteora-ag/dynamic-bonding-curve-sdk');
const { DynamicBondingCurveClient, buildCurveWithMarketCap, deriveTokenBadgeAddress,
        TokenType, ActivationType, CollectFeeMode, MigrationOption, MigrationFeeOption,
        TokenDecimal, BaseFeeMode, TokenAuthorityOption } = SDK;

const badge = deriveTokenBadgeAddress(mintKp.publicKey);
const badgeAcc = await conn.getAccountInfo(badge);
console.log('token badge for it:', badgeAcc ? 'EXISTS' : 'does not exist (testing permissionless path)');

const curve = buildCurveWithMarketCap({
  // Shapes a REX-Chain-like launch: 1B supply, opens near $5K, graduates to a locked DAMM v2 pool.
  // The numbers are placeholders; what is under test is the QUOTE MINT, not the curve.
  token: {
    tokenType: TokenType.SPLToken,            // the LAUNCHED token — plain SPL, our choice
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: 6,                // REX is 6dp
    tokenAuthorityOption: TokenAuthorityOption.Immutable ?? 0,
    totalTokenSupply: 1_000_000_000,
    leftover: 0,
  },
  fee: {
    baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,   // fees accrue in the QUOTE — i.e. in REX
    creatorTradingFeePercentage: 50,             // launcher's half; the rest is the partner's (ours)
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    // Permanently locked on both sides: the same "cannot rug" guarantee as a burned LP, except
    // locked liquidity still accrues claimable fees — which is the entire point of the move.
    partnerPermanentLockedLiquidityPercentage: 100,
    partnerLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
  },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
    totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Slot,
  initialMarketCap: 5_000,
  migrationMarketCap: 50_000,
});

const client = new DynamicBondingCurveClient(conn, 'confirmed');
const cfgKp = Keypair.generate();
try {
  const ctx = await client.partner.createConfig({
    config: cfgKp.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    quoteMint: mintKp.publicKey,          // <- the REX-shaped Token-2022 mint
    payer: payer.publicKey,
    ...curve,
  });
  const s2 = await sendAndConfirmTransaction(conn, ctx, [payer, cfgKp], { commitment: 'confirmed' });
  console.log('\n✅✅ DBC ACCEPTED a REX-shaped Token-2022 quote mint WITH NO BADGE');
  console.log('   config', cfgKp.publicKey.toBase58());
  console.log('   sig   ', s2.slice(0, 20) + '…');
  console.log('\n=> REX-quoted launches on Meteora DBC are possible without Meteora granting anything.');
} catch (e) {
  const msg = String(e.message || e);
  console.log('\n❌ createConfig FAILED');
  console.log('   ', msg.slice(0, 400));
  if (/badge|InvalidQuoteMint|0x17ac|AccountNotInitialized/i.test(msg))
    console.log('\n=> Looks like a TOKEN BADGE is required. Badges are created by Meteora, so REX-quoted\n   launches would be gated on them. SOL/USDC-quoted launches would still work today.');
}
