// Graduating a launch into a Raydium CPMM pool.
//
// Our own AMM is read by nobody: DexScreener, Birdeye and Jupiter index POOL PROGRAMS they have
// written adapters for, not arbitrary programs. A graduated coin that never leaves our program has
// no chart, no routing and no aggregator volume anywhere. Moving the reserves into a Raydium
// constant-product pool — and burning the LP in the same instruction that creates it — buys all of
// that, and is the same shape a pump.fun graduate takes.
//
// Every address here is derived or pinned, never guessed: the seeds and ids come from
// raydium-io/raydium-cp-swap itself.
import crypto from 'node:crypto';
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { cfg } from './config.mjs';

const DEVNET = /devnet/i.test(cfg.rpcUrl || '');
/** The cp-swap deployment for this cluster. Devnet is NOT the only CPMM-looking program there. */
export const CPMM = new PublicKey(DEVNET
  ? 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'
  : 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
/** Where Raydium's pool-creation fee goes. Misspelled in their source as `reveiver`. */
export const CREATE_POOL_FEE = new PublicKey(DEVNET
  ? '3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy'
  : 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8');

const seed = (s) => Buffer.from(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, CPMM)[0];

/** Raydium sorts the pair by mint, ascending. Everything else follows from that. */
export const sortMints = (a, b) => (new PublicKey(a).toBuffer().compare(new PublicKey(b).toBuffer()) < 0 ? [a, b] : [b, a]);

export const ammConfig = (index = 0) => {
  const b = Buffer.alloc(2); b.writeUInt16BE(index);
  return pda([seed('amm_config'), b]);
};
export const cpmmAuthority = () => pda([seed('vault_and_lp_mint_auth_seed')]);
export const poolState = (config, mint0, mint1) =>
  pda([seed('pool'), new PublicKey(config).toBuffer(), new PublicKey(mint0).toBuffer(), new PublicKey(mint1).toBuffer()]);
export const lpMint = (pool) => pda([seed('pool_lp_mint'), new PublicKey(pool).toBuffer()]);
export const poolVault = (pool, mint) => pda([seed('pool_vault'), new PublicKey(pool).toBuffer(), new PublicKey(mint).toBuffer()]);
export const observation = (pool) => pda([seed('observation'), new PublicKey(pool).toBuffer()]);

/**
 * Every account `migrate_to_amm` needs, in the order the program passes them on.
 * `tokenProgramOf` is injected so this module does not have to open its own RPC connection.
 */
export async function migrateAccounts({ launch, mint, quoteMint, tokenVault, quoteVault, payer, tokenProgramOf, configIndex = 0 }) {
  const [m0, m1] = sortMints(mint, quoteMint);
  const config = ammConfig(configIndex);
  const pool = poolState(config, m0, m1);
  const lp = lpMint(pool);
  // The LP mint is created by Raydium under the plain token program, so its ATA derives under that
  // one — not under whichever program the quote happens to use.
  const creatorLp = getAssociatedTokenAddressSync(lp, new PublicKey(launch), true, TOKEN_PROGRAM_ID);
  return {
    launch: new PublicKey(launch),
    mint: new PublicKey(mint),
    quoteMint: new PublicKey(quoteMint),
    tokenVault: new PublicKey(tokenVault),
    quoteVault: new PublicKey(quoteVault),
    creatorLpToken: creatorLp,
    payer: new PublicKey(payer),
    cpSwapProgram: CPMM,
    ammConfig: config,
    cpmmAuthority: cpmmAuthority(),
    poolState: pool,
    lpMint: lp,
    poolVault0: poolVault(pool, m0),
    poolVault1: poolVault(pool, m1),
    createPoolFee: CREATE_POOL_FEE,
    observationState: observation(pool),
    tokenProgram: TOKEN_PROGRAM_ID,
    token0Program: await tokenProgramOf(m0),
    token1Program: await tokenProgramOf(m1),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
    _pool: pool, _lpMint: lp, _creatorLp: creatorLp,
  };
}

/** Raydium is an Anchor program, so its selector is sha256("global:initialize")[..8]. */
const INITIALIZE = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

/**
 * How much LP a fresh pool mints to its creator. Raydium takes sqrt(a*b) and keeps 100 back
 * permanently — it never mints that part at all, which is why burning what the creator receives
 * leaves the supply at exactly zero and makes `migrate_confirm`'s check unambiguous.
 */
export function lpMintedFor(amount0, amount1) {
  const p = BigInt(amount0) * BigInt(amount1);
  if (p <= 0n) return 0n;
  // integer square root, floor — the same thing Raydium's U128::sqrt does
  let x = p, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + p / x) / 2n; }
  return x > 100n ? x - 100n : 0n;
}

/** Raydium's `initialize`, built by hand: its own crate pins an Anchor version we cannot share. */
export function initializeIx(a) {
  const data = Buffer.alloc(8 + 24);
  INITIALIZE.copy(data, 0);
  data.writeBigUInt64LE(BigInt(a.initAmount0), 8);
  data.writeBigUInt64LE(BigInt(a.initAmount1), 16);
  data.writeBigUInt64LE(0n, 24);  // open_time 0 — tradeable the moment it exists
  const [m0, m1] = sortMints(a.mint.toBase58 ? a.mint.toBase58() : a.mint,
    a.quoteMint.toBase58 ? a.quoteMint.toBase58() : a.quoteMint);
  const ro = (pubkey) => ({ pubkey: new PublicKey(pubkey), isSigner: false, isWritable: false });
  const rw = (pubkey) => ({ pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true });
  return {
    programId: CPMM,
    keys: [
      { pubkey: new PublicKey(a.creator), isSigner: true, isWritable: true },
      ro(a.ammConfig), ro(a.cpmmAuthority), rw(a.poolState),
      ro(m0), ro(m1),
      rw(a.lpMint), rw(a.creatorToken0), rw(a.creatorToken1), rw(a.creatorLpToken),
      rw(a.poolVault0), rw(a.poolVault1), rw(a.createPoolFee), rw(a.observationState),
      ro(a.tokenProgram), ro(a.token0Program), ro(a.token1Program),
      ro(a.associatedTokenProgram), ro(a.systemProgram), ro(a.rent),
    ],
    data,
  };
}

// ---------------------------------------------------------------- deposit / withdraw
//
// Anchor discriminators: the first 8 bytes of sha256("global:<name>"). Raydium's CPMM is an Anchor
// program, so its instructions are selected the same way ours are.
const anchorDisc = (name) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8);
const DEPOSIT = anchorDisc('deposit');
const WITHDRAW = anchorDisc('withdraw');

/**
 * Add liquidity to an existing CPMM pool.
 *
 * `lpAmount` is what you want OUT; the two maximums are the most you will pay for it. Those caps are
 * the only protection against the pool's ratio moving between quoting and landing — set them from a
 * fresh read with a slippage allowance, never from a number computed minutes ago.
 */
export function depositIx(a) {
  const data = Buffer.alloc(8 + 24);
  DEPOSIT.copy(data, 0);
  data.writeBigUInt64LE(BigInt(a.lpAmount), 8);
  data.writeBigUInt64LE(BigInt(a.maxAmount0), 16);
  data.writeBigUInt64LE(BigInt(a.maxAmount1), 24);
  const ro = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false });
  const rw = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true });
  return {
    programId: CPMM,
    keys: [
      { pubkey: new PublicKey(a.owner), isSigner: true, isWritable: false },
      ro(a.cpmmAuthority), rw(a.poolState),
      rw(a.ownerLpToken), rw(a.token0Account), rw(a.token1Account),
      rw(a.poolVault0), rw(a.poolVault1),
      ro(a.tokenProgram), ro(a.token2022Program),
      ro(a.mint0), ro(a.mint1), rw(a.lpMint),
    ],
    data,
  };
}

/**
 * Take liquidity back out. `minAmount0/1` is the floor you will accept — the mirror of deposit's
 * caps, and the thing that stops a withdrawal landing into a pool somebody just drained.
 *
 * There is no separate "claim fees" instruction on a constant-product CPMM: fees accrue INTO the
 * pool, so each LP token is worth progressively more of both sides. Withdrawing is how the yield is
 * realised, which is why the crank measures earnings as the growth in what its LP is redeemable for
 * rather than looking for a rewards balance that will never exist.
 */
export function withdrawIx(a) {
  const data = Buffer.alloc(8 + 24);
  WITHDRAW.copy(data, 0);
  data.writeBigUInt64LE(BigInt(a.lpAmount), 8);
  data.writeBigUInt64LE(BigInt(a.minAmount0), 16);
  data.writeBigUInt64LE(BigInt(a.minAmount1), 24);
  const ro = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: false });
  const rw = (k) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true });
  return {
    programId: CPMM,
    keys: [
      { pubkey: new PublicKey(a.owner), isSigner: true, isWritable: false },
      ro(a.cpmmAuthority), rw(a.poolState),
      rw(a.ownerLpToken), rw(a.token0Account), rw(a.token1Account),
      rw(a.poolVault0), rw(a.poolVault1),
      ro(a.tokenProgram), ro(a.token2022Program),
      ro(a.mint0), ro(a.mint1), rw(a.lpMint),
      ro(a.memoProgram),
    ],
    data,
  };
}
