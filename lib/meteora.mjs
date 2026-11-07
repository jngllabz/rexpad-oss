// Meteora Dynamic Bonding Curve — REX Chain's launch venue.
//
// WHY THIS REPLACED OUR OWN CURVE. DexScreener, Jupiter, Birdeye and GeckoTerminal index
// SPECIFIC programs, not arbitrary ones. Sampled live, the Solana set is raydium, meteora, orca,
// pumpswap, pumpfun and meteoradbc. REX Chain's own bonding curve was its own program, so a coin on
// it was invisible everywhere by construction — both live mainnet launches returned `pairs: null`
// from DexScreener and "not tradable" from Jupiter, and no amount of work on our own site changed
// that.
//
// The second half of the problem was worse and only visible from reading the program: graduation
// burned the LP (`migrate_confirm` requires `lp_mint.supply == 0`), `buy` rejected a migrated
// launch, and no instruction anywhere could claim a pool fee. So REX earned nothing from a coin
// from the moment it graduated. Fees existed only where the coin was invisible, and where it was
// visible they were zero. One problem, not two.
//
// DBC answers both: `meteoradbc` is indexed from the first trade, and liquidity migrates into a
// DAMM v2 pool that is PERMANENTLY LOCKED rather than burned — the same "nobody can pull this"
// guarantee, except locked liquidity goes on accruing claimable fees instead of ending them.
//
// THE QUOTE-MINT QUESTION, SETTLED. DBC needs a TokenBadge for a quote mint that is "not
// permissionless-supported (for example Token-2022 mints with extra extensions)", and badges are
// minted by Meteora rather than by us — so if $REX needed one, every REX-quoted launch would have
// been gated on a third party. $REX is Token-2022 but carries only metadataPointer and
// tokenMetadata: no transfer fee, no hook. `tools/dbc_spike.mjs` built a devnet mint with exactly
// that extension set and called createConfig against it; it was accepted with no badge. That spike
// is kept rather than deleted, because the answer is Meteora's to change.
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
         getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
         createTransferCheckedInstruction } from '@solana/spl-token';
import anchorPkg from '@coral-xyz/anchor';
import { cfg, log, warn } from './config.mjs';

const { BN } = anchorPkg;

let _sdk = null;
/** The SDK is ~1MB and most requests never touch a launch, so it is loaded on first use. */
async function sdk() {
  if (!_sdk) _sdk = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  return _sdk;
}

export const DBC_PROGRAM_ID = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const DAMM_V2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

let _client = null;
export async function client(conn) {
  if (_client) return _client;
  const { DynamicBondingCurveClient } = await sdk();
  _client = new DynamicBondingCurveClient(conn, 'confirmed');
  return _client;
}
/** Tests and the devnet spike need a clean client when they swap connections. */
export function resetClient() { _client = null; }

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Which token program owns a mint. Decides the base token type for a launch quoted in it. */
export async function isToken2022(conn, mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`quote mint ${String(mint).slice(0, 8)}… does not exist on this cluster`);
  return info.owner.toBase58() === TOKEN_2022;
}

/**
 * Does this quote mint need a TOKEN BADGE, and does one exist?
 *
 * ⛔ THIS IS NOT OPTIONAL PLUMBING. DBC refuses a quote mint carrying "extra" Token-2022 extensions
 * unless a badge account is passed as a remaining account — and the badge is created by Meteora, not
 * by us. Every xStock (AAPLx, TSLAx, NVDAx, GLDx …) carries SEVEN: transferHook, permanentDelegate,
 * pausableConfig, defaultAccountState, confidentialTransferMint, scaledUiAmountConfig and metadata.
 *
 * REX Chain already offered five xStocks as quote assets while never passing a badge, so every one
 * of those launches would have failed on chain with "Invalid token badge" — AFTER the user signed.
 * Nobody had found out because nobody had launched against one yet.
 *
 * Meteora HAS badged the real xStocks on mainnet; the badge simply has to be handed to the
 * instruction. $REX needs none, because metadata-only extensions take the permissionless path.
 */
export async function badgeFor(conn, mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`quote mint ${String(mint).slice(0, 8)}… does not exist on this cluster`);
  if (info.owner.toBase58() !== TOKEN_2022) return { needed: false, badge: null };

  // Metadata extensions are permissionless; anything else is "extra" and gates on a badge. Decided
  // by reading the mint rather than by a list of known tickers, so a new asset cannot slip through.
  const { getMint, getExtensionTypes, ExtensionType } = await import('@solana/spl-token');
  const m = await getMint(conn, new PublicKey(mint), 'confirmed', new PublicKey(TOKEN_2022));
  const exts = getExtensionTypes(m.tlvData);
  // Read the values off the enum rather than hardcoding numbers. I hardcoded 16 for MetadataPointer
  // and it is 18, which flagged $REX — the one Token-2022 quote that works today — as needing a
  // badge it does not have, and would have refused every REX-quoted launch.
  const PERMISSIONLESS = new Set([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
  const extra = exts.filter((e) => !PERMISSIONLESS.has(e));
  if (!extra.length) return { needed: false, badge: null, extensions: exts };

  // ⛔ A NON-ZERO TRANSFER FEE IS NOT A BADGE PROBLEM, AND SAYING IT IS SENDS PEOPLE TO THE WRONG
  // PLACE. The program has two separate errors here, and I asked it which one it actually returns:
  //
  //   $GP, $SI, $MASK, $ALLINU -> 6081 QuoteMintHasNonZeroTransferFee (token.rs:232)
  //   a mint whose only problem is its extensions -> 6080 InvalidTokenBadge
  //
  // So for a taxed mint a badge changes NOTHING — the fee itself is the refusal, and the only
  // thing that lifts it is setting that fee to zero, which only the mint's transfer-fee authority
  // can do. We told the owner for days that $GP was waiting on a Meteora badge. It is not, and it
  // never was: $GP charges 3% on every transfer, and DBC will not price a curve in an asset that
  // shrinks in transit.
  const { getTransferFeeConfig } = await import('@solana/spl-token');
  let feeBps = 0, feeAuthority = null;
  try {
    const cfg = getTransferFeeConfig(m);
    if (cfg) {
      // Both scheduled rates matter: the older one still applies until the newer epoch arrives.
      feeBps = Math.max(cfg.olderTransferFee.transferFeeBasisPoints, cfg.newerTransferFee.transferFeeBasisPoints);
      feeAuthority = cfg.transferFeeConfigAuthority?.toBase58() || null;
    }
  } catch { /* no transfer-fee extension is the normal case */ }

  const { deriveTokenBadgeAddress } = await sdk();
  const addr = deriveTokenBadgeAddress(new PublicKey(mint));
  const exists = !!(await conn.getAccountInfo(addr));
  return {
    needed: true, badge: exists ? addr : null, exists, extensions: exts, extra,
    feeBps, feeAuthority,
    // A taxed mint is refused whatever its badge status, so this is the blocker that matters.
    blockedByFee: feeBps > 0,
  };
}

/**
 * Which of our quote assets can actually be launched against, asked of the chain.
 *
 * ⛔ A PAIR THAT CANNOT BE LAUNCHED MUST NOT BE OFFERED. `buildLaunch` already refuses a badge-less
 * quote before anything is signed, which is the right place for the rule and the wrong place for
 * the user to meet it: Elio picked SUPER INU, then ALLINU, filled the whole form twice, hit Launch
 * twice and got a wall of text about Meteora token badges at three in the morning. The form had
 * offered him both.
 *
 * Four of the five META pairs are in that state — ZCAT, SI, MASK and ALLINU are Token-2022 mints
 * carrying a transfer fee, which DBC will not take as a quote without a badge Meteora has not
 * issued. That is not a list worth hardcoding: Meteora can issue a badge any day, and a hardcoded
 * block would keep refusing the pair long after it started working. So it is read off the chain and
 * refreshed, and the pair comes back by itself the moment a badge exists.
 *
 * Returns { SYMBOL: null | reason }. A mint we cannot reach is left alone rather than blocked — an
 * RPC with a cold shoulder must not empty the launch form.
 */
export async function badgeSweep(conn, quotes) {
  const out = {};
  for (const q of quotes) {
    if (!q?.mint) continue;
    try {
      const b = await badgeFor(conn, q.mint);
      // ⛔ NAME THE REAL BLOCKER. These two are not the same problem and do not have the same fix.
      if (b.blockedByFee) {
        const pct = (b.feeBps / 100).toFixed(b.feeBps % 100 ? 2 : 0);
        const renounced = !b.feeAuthority || b.feeAuthority === '11111111111111111111111111111111';
        // ⛔ THIS DESCRIBES METEORA, NOT THE SITE, AND IT USED TO CLAIM OTHERWISE. "It cannot be a
        // pair here" was true when Meteora was the only venue; it stopped being true the day
        // LaunchLab was wired up, which takes fee-bearing quote mints quite happily — $GP charges
        // this same 3% and launches there. Saying a renounced fee authority settles the matter
        // forever is the sentence that made four live pairs look permanently dead.
        const elsewhere = (await import('./launchlab.mjs')).llHasConfig(q.mint);
        out[q.symbol] = `it charges a ${pct}% fee on every transfer, and Meteora will not price a curve`
          + ' in an asset that shrinks in transit (error 6081). '
          + (elsewhere
            ? 'It launches on Raydium LaunchLab instead, which takes fee-bearing pairs.'
            : renounced
              ? 'Its fee authority has been renounced, so that will never change, and no other venue carries it yet.'
              : 'Only the mint\'s transfer-fee authority can set that fee to zero; a Meteora token badge would NOT help.');
      } else {
        out[q.symbol] = b.needed && !b.badge
          ? 'Meteora has not issued a token badge for it, and DBC will not take a quote mint carrying these extensions without one'
          : null;
      }
    } catch (e) { warn('badgeSweep', q.symbol, e.message); }
  }
  return out;
}

// ---------------------------------------------------------------- the curve shape
/**
 * Translate a REX launch into a DBC config.
 *
 * ONE CONFIG PER LAUNCH, deliberately. A config carries the fee parameters and the feeClaimer, so a
 * shared config would mean every launch on the platform had identical fees and REX Chain's "the
 * launcher sets their own split" would stop being true. The extra account rent is the price of
 * keeping the product.
 *
 * `poolFeeBps` is the SINGLE pool fee. This is the real change from the old model: our program used
 * to enforce five buckets per swap on chain, and a pool has one number. The buckets still exist —
 * they are how the CLAIMED fee is divided afterwards (see lib/fees.mjs) — but the division is now
 * arithmetic we run rather than arithmetic the chain guarantees. That is weaker and is stated
 * plainly rather than buried.
 */
export async function curveConfig({
  poolFeeBps,
  creatorSharePct,             // of the trading fee, the launcher's half. The rest is REX Chain's.
  totalSupply = 1_000_000_000,
  initialMarketCap,
  migrationMarketCap,
  quoteDecimals,               // ⛔ REQUIRED. A default of 6 sizes the curve 1000x wrong on a 9-decimal quote.
  quoteIsToken2022 = false,    // see the note on baseTokenType below
  hooked = false,              // a transfer hook forces the base mint to Token-2022
  decayFromBps = null,         // anti-snipe: start high and settle to poolFeeBps
  decaySeconds = 0,
}) {
  if (!Number.isInteger(quoteDecimals)) throw new Error('curveConfig needs the quote decimals — read them from the mint, never assume 6');
  const S = await sdk();
  const {
    buildCurveWithMarketCap, TokenType, TokenDecimal, TokenAuthorityOption,
    ActivationType, CollectFeeMode, MigrationOption, MigrationFeeOption, BaseFeeMode,
  } = S;

  // A decaying opening fee is DBC's own fee scheduler rather than the bespoke one REX carried.
  // Same intent — make the first seconds expensive for snipers — with none of our code to maintain.
  const scheduled = decayFromBps && decaySeconds > 0;
  const baseFeeParams = scheduled
    ? {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: decayFromBps, endingFeeBps: poolFeeBps,
          numberOfPeriod: Math.max(1, Math.min(60, Math.floor(decaySeconds / 5))),
          totalDuration: decaySeconds,
        },
      }
    : {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: poolFeeBps, endingFeeBps: poolFeeBps, numberOfPeriod: 0, totalDuration: 0 },
      };

  // ⛔ THE SDK'S OWN REFUSAL IS UNREADABLE, AND IT IS A REFUSAL A LAUNCHER CAN ACT ON.
  // "Not enough liquidity, migrationThreshold: 310645297843343 amountLeft: 18636" means the curve
  // cannot be balanced: a quote with many decimals and a very low price needs more raw quote units
  // than there are raw base units to price them against. Measured across all 39 quotes at live
  // prices, exactly one hits it — ZCAT, which is already refused for having no Meteora token badge,
  // so nobody can reach this today. The wrapper is here for the pair that is added tomorrow.
  const build = (args) => {
    try { return buildCurveWithMarketCap(args); }
    catch (e) {
      if (/not enough liquidity/i.test(String(e?.message))) {
        throw new Error('This pair cannot carry a curve at that size — the pair token is worth too '
          + 'little per unit for the opening and migration targets to fit. Pick a different pair, or '
          + 'ask for the targets to be raised for it.');
      }
      throw e;
    }
  };
  const built = build({
    token: {
      // THE LAUNCHED TOKEN IS ALWAYS A PLAIN SPL MINT, whatever the quote is. Verified on devnet
      // against a Token-2022 quote: both an SPL base and a Token-2022 base are accepted.
      //
      // ⛔ An earlier version of this comment claimed the two MUST match, on the strength of an
      // experiment where the SPL case failed. That experiment was wrong: the enum member is
      // `SPLToken`, not `SPL`, so `TokenType.SPL` was plain `undefined` and the base type was never
      // set at all — the failure was a typo, not an incompatibility. Re-run with the right name,
      // both combinations are accepted.
      //
      // Plain SPL is the deliberate choice because it is the most widely supported thing a pool,
      // an aggregator or a wallet can be handed. The mint carries no extensions either way: a base
      // with a transfer fee or a hook is what gets refused somewhere downstream, and nothing about
      // REX Chain needs one.
      // ⛔ A HOOK FORCES TOKEN-2022 ON THE LAUNCHED COIN, and that is not a detail. Only Token-2022
      // mints can carry a transfer hook, so choosing a rule changes what the coin IS: a Token-2022
      // mint that some wallets, aggregators and terminals treat differently from a plain SPL one,
      // and that would itself need a Meteora badge if anyone ever tried to use it as a quote asset.
      // The launch form says so before the choice is made, because the mint is immutable afterwards.
      tokenType: hooked ? TokenType.Token2022 : TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: quoteDecimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable ?? 0,
      totalTokenSupply: totalSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams,
      dynamicFeeEnabled: false,
      // Fees accrue in the QUOTE asset. This is what keeps REX Chain's oldest promise intact — the
      // fee is never taken in the launched token, so a coin is never sold to fund its own payout.
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: creatorSharePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      // 100% PERMANENTLY LOCKED on the partner side. Identical rug-resistance to the burned LP this
      // replaces, with the one difference that is the entire point of the move: locked liquidity
      // still earns claimable fees, where burned liquidity earns nobody anything ever again.
      partnerPermanentLockedLiquidityPercentage: 100,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Slot,
    initialMarketCap,
    migrationMarketCap,
  });

  // ⛔ RE-ASSERT tokenType on the result. SPLToken is 0, and a falsy zero does not survive the
  // builder — the config comes back with `tokenType: undefined`, which downstream resolves to the
  // Token-2022 pool initialiser and fails on chain with InvalidTokenType, AFTER the user has signed.
  built.tokenType = hooked ? TokenType.Token2022 : TokenType.SPLToken;
  return built;
}

// ---------------------------------------------------------------- launching
/**
 * Build a launch: config, pool, and optionally the dev's first buy.
 *
 * SHAPE, MEASURED RATHER THAN ASSUMED. Without a dev buy the SDK returns ONE Transaction. With one
 * it returns TWO — `createConfigTx` and `createPoolWithFirstBuyTx` — which also need different
 * co-signers: the config keypair signs the first, the mint keypair the second. Signing both with
 * both looks harmless and fails, so each step carries its own signer list.
 *
 * Two transactions means the dev buy is NOT atomic with pool creation: there is a window, however
 * short, in which the pool exists and the dev has not bought. That window is the launcher's risk to
 * accept and is why the UI should say so rather than imply one click does everything.
 *
 * Nothing is signed here — the caller is a web request and the signer is the user's wallet.
 */
export async function buildLaunch({
  conn, creator, quoteMint, name, symbol, uri = '', uriBase = '',
  poolFeeBps, creatorSharePct, initialMarketCap, migrationMarketCap,
  quoteDecimals, devBuy = 0n, decayFromBps = null, decaySeconds = 0,
  transferHookProgram = null, rule = null, ruleParams = null,
}) {
  const c = await client(conn);
  const config = Keypair.generate();
  const baseMint = Keypair.generate();
  // ⛔ THE METADATA URI IS SET HERE OR IT IS NEVER SET AT ALL.
  // These mints are created with `TokenAuthorityOption.Immutable` and a null update authority, so
  // nothing can edit the metadata afterwards — not us, not the launcher, not Meteora. $BITE and
  // $REXWEEN both went out with an EMPTY uri, which means every wallet, scanner, bot and terminal
  // outside this site has no JSON to fetch and therefore no image, for as long as the coins exist.
  // The art was only ever in our own database. The address is known here, one line after it is
  // generated, which is the only moment this can be fixed.
  if (uriBase && !uri) uri = `${uriBase.replace(/\/+$/, '')}/${baseMint.publicKey.toBase58()}.json`;
  // Read the quote's owning program off the chain rather than trusting a caller's flag: get this
  // wrong and the launch fails on chain after the user has already approved it.
  const quoteIsToken2022 = await isToken2022(conn, quoteMint);
  // Refuse BEFORE building rather than letting the chain refuse after the user has signed and paid.
  const badge = await badgeFor(conn, quoteMint);
  if (badge.needed && !badge.badge) {
    throw new Error(`${String(quoteMint).slice(0, 8)}… needs a Meteora token badge and none exists on `
      + `this cluster. Badges are issued by Meteora, not by us, so this pair cannot be launched here yet.`);
  }
  const curve = await curveConfig({
    poolFeeBps, creatorSharePct, initialMarketCap, migrationMarketCap,
    quoteDecimals, quoteIsToken2022, decayFromBps, decaySeconds,
    hooked: !!transferHookProgram,
  });

  const base = {
    // Passed only when the quote actually needs one; DBC takes it as a remaining account.
    ...(badge.badge ? { tokenBadge: badge.badge } : {}),
    config: config.publicKey,
    feeClaimer: new PublicKey(cfg.feeClaimer || creator),
    leftoverReceiver: new PublicKey(cfg.feeClaimer || creator),
    quoteMint: new PublicKey(quoteMint),
    payer: new PublicKey(creator),
    ...curve,
    preCreatePoolParam: {
      name, symbol, uri,
      poolCreator: new PublicKey(creator),
      baseMint: baseMint.publicKey,
    },
  };

  // ⛔ THE HOOK HAS TO BE NAMED IN BOTH HALVES. The config records which program the token answers
  // to and the pool initialiser needs it again to resolve the hook's own accounts. The SDK exposes a
  // parallel set of entry points for this rather than an extra flag on the ordinary ones, so the
  // whole launch forks here — pass the program to one and not the other and the pool is created for
  // a token whose transfers it cannot execute.
  const hook = transferHookProgram ? { transferHookProgram: new PublicKey(transferHookProgram) } : null;
  let steps;
  let devBuyAfter = 0n;
  if (hook) {
    // ⛔ A HOOKED LAUNCH CANNOT BUNDLE THE FIRST BUY, AND BUNDLING IT IS WHAT BROKE.
    //
    // The order is forced by the chain. The pool is created naming a hook program; the hook's own
    // `initialize` then writes the extra-account-meta list that the token program reads on EVERY
    // transfer. Until that list exists no transfer of this token can resolve its accounts — so a
    // first buy packed into the pool transaction is asking the token program to move a token whose
    // rules are not yet readable. The SDK says exactly that and refuses: "Unable to resolve
    // transfer-hook remaining accounts … pass transferHookAccountsInfo and transferHookAccounts on
    // the first-buy params". Julz hit it on 9 Oct and launched without a dev buy to get past it.
    //
    // Worse was the case where nothing refused: the pool was created, the rule was never switched
    // on because nothing ever sent that instruction, and the coin could not be transferred at all,
    // for ever. B24837 and KT are both in that state on mainnet.
    //
    // So the hooked path is: create the pool, switch the rule ON, and only then buy — as an
    // ordinary hook-aware swap, through the same code every other trade uses.
    const ruleSteps = [];
    if (rule) {
      const HK = await import('./hooked.mjs');
      const groups = await HK.buildRuleOn({
        rule, params: ruleParams || {}, mint: baseMint.publicKey,
        pool: await poolAddress(quoteMint, baseMint.publicKey, config.publicKey),
        // ⛔ HAND THE CONFIG IN. The two rules that need it used to read it back off the pool
        // account — an account that cannot exist yet, since `baseMint` was generated a few lines
        // above and its pool is created by the step AFTER this one. Both rules threw on every
        // launch. The pool address on the line above is literally derived from this config, so
        // there is nothing to go and look up.
        poolConfig: config.publicKey,
        payer: new PublicKey(creator), supplyRaw: 1_000_000_000n * 10n ** 6n, decimals: 6,   // tokenBaseDecimal is SIX and the supply is fixed above
      });
      groups.forEach((ixs, i) => ruleSteps.push({
        label: groups.length > 1 ? `switch the rule on (${i + 1}/${groups.length})` : 'switch the rule on',
        ixs, signers: [],
      }));
    }
    steps = [
      { label: 'config+pool', tx: await c.partner.createConfigAndPoolWithTransferHook({ ...base, ...hook }), signers: [config, baseMint] },
      ...ruleSteps,
    ];
    // Handed back to the caller to run afterwards rather than built here: the swap reads pool state,
    // and the pool does not exist until step one has landed.
    devBuyAfter = devBuy;
  } else if (devBuy > 0n) {
    // ONE object, used by whichever entry point the hook decision picks. Written out twice, the dev
    // buy's slippage floor is a value that can drift between the hooked and unhooked paths — and it
    // would drift silently, because only one of the two is exercised by any given launch.
    const firstBuyParam = {
      buyer: new PublicKey(creator),
      buyAmount: new BN(String(devBuy)),
      // The dev eats their own slippage. A minimum of 0 here would let the launcher be
      // sandwiched in the very transaction that creates their coin.
      minimumAmountOut: new BN(1),
      referralTokenAccount: null,
    };
    const r = await c.partner.createConfigAndPoolWithFirstBuy({ ...base, firstBuyParam });
    steps = [
      { label: 'config', tx: r.createConfigTx, signers: [config] },
      { label: 'pool+buy', tx: r.createPoolWithFirstBuyTx, signers: [baseMint] },
    ];
  } else {
    steps = [{ label: 'config+pool', tx: await c.partner.createConfigAndPool(base), signers: [config, baseMint] }];
  }
  // A transaction cannot be serialized without a fee payer and a blockhash, and this one has to
  // survive the trip to a browser and back. Set here rather than in the route so every caller —
  // route, crank or test — gets something it can actually send.
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const creatorPk = new PublicKey(creator);
  // A rule step arrives as raw instructions rather than an SDK transaction, because the hook
  // programs are not in any SDK — they are Hooked's own, and the layouts are hand-built. Wrap them
  // here so every step leaves this function in the same shape.
  const { Transaction } = await import('@solana/web3.js');
  for (const st of steps) {
    if (!st.tx && st.ixs) { st.tx = new Transaction(); st.tx.add(...st.ixs); delete st.ixs; }
    st.tx.feePayer = creatorPk;
    st.tx.recentBlockhash = blockhash;
  }

  return {
    steps,
    // ⛔ NOT BUILT HERE. The dev buy reads pool state and the pool does not exist until step one has
    // landed, so the caller runs it afterwards as an ordinary hook-aware swap. Zero on every
    // unhooked launch, where the buy is still bundled into the pool transaction as before.
    devBuyAfter: String(devBuyAfter),
    txs: steps.map((s) => s.tx),      // convenience for callers that only need the transactions
    config: config.publicKey.toBase58(),
    mint: baseMint.publicKey.toBase58(),
    // Known now, so the caller never has to search for it afterwards.
    pool: await poolAddress(quoteMint, baseMint.publicKey, config.publicKey),
    blockhash,
  };
}

// ---------------------------------------------------------------- trading
/**
 * The pool and config accounts a quote prices against, fetched once.
 *
 * Pulled out so a search over many candidate sizes costs ONE set of account reads rather than one
 * per probe: `swapQuote2` is pure given the accounts, and this RPC is rate-limited enough that the
 * difference is the whole feasibility of `maxFillable`.
 */
async function poolAndConfig(conn, pool) {
  const c = await client(conn);
  // getPool returns a WRAPPER, { poolState: … }, and swapQuote2 wants that wrapper — internally it
  // reads `virtualPool.poolState.quoteReserve`. Unwrapping it first fails deep inside the SDK.
  const virtualPool = await c.state.getPool(new PublicKey(pool));
  if (!virtualPool?.poolState?.config) throw new Error('pool not found, or its shape changed');
  // getPoolConfig, by contrast, returns the config account directly. The asymmetry is the SDK's.
  const config = await c.state.getPoolConfig(virtualPool.poolState.config);
  if (!config?.quoteMint) throw new Error('pool config unreadable, or its shape changed');
  return { c, virtualPool, config };
}

/**
 * The largest amount this curve can actually fill right now, in raw quote units.
 *
 * ⛔ "INSUFFICIENT LIQUIDITY" IS NOT AN ANSWER, IT IS A REFUSAL. A bonding curve holds a finite
 * amount of base, so a buy past the end of it cannot fill — which is correct, and which the SDK
 * reports in two words that tell a buyer nothing about what they CAN do. On a brand-new coin, the
 * moment everybody is trying to buy is exactly the moment the curve is thinnest, so this is the
 * error people meet at the worst possible time. The team reported it as "questions about initial
 * liquidity, fomo doesn't let sometimes buy".
 *
 * Binary search over the one fetched pool state: ~20 pure evaluations, no extra RPC.
 * Returns 0n when even one unit cannot fill (a graduated or empty curve).
 */
export async function maxFillable({ conn, pool, swapBaseForQuote = false, slippageBps = 100, upper }) {
  const { c, virtualPool, config } = await poolAndConfig(conn, pool);
  const { SwapMode } = await sdk();
  const currentPoint = new BN(await conn.getSlot());
  /**
   * ⛔ THE PREDICATE IS "DOES THE CURVE REFUSE IT", NOT "DOES IT RETURN SOMETHING".
   *
   * `out > 0` is NOT monotonic: one raw unit rounds to an output of zero, mid-sized amounts fill,
   * and only past the end of the curve does the SDK throw. False-true-false defeats a binary
   * search — seeded with `fits(1)` it answers 0 for every pool, which is what my first version of
   * this did. Refusal, by contrast, is monotonic: everything up to the curve's capacity is
   * accepted and everything beyond it throws, so that is the edge to search for.
   */
  const accepted = async (amt) => {
    if (amt <= 0n) return false;
    try {
      await c.pool.swapQuote2({
        virtualPool, config, swapMode: SwapMode.ExactIn, amountIn: new BN(String(amt)),
        swapBaseForQuote, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint,
      });
      return true;
    } catch (e) {
      // Only the curve's own refusal means "too big". Anything else is a real fault and must not
      // be silently read as a boundary, or the number handed to the buyer is invented.
      if (/Insufficient Liquidity/i.test(e?.message || '')) return false;
      throw e;
    }
  };
  const max = await searchMax(accepted, BigInt(String(upper)));
  if (max <= 0n) return 0n;
  // A size the curve accepts but that returns nothing is no use to anybody — report it as none.
  try {
    const q = await c.pool.swapQuote2({
      virtualPool, config, swapMode: SwapMode.ExactIn, amountIn: new BN(String(max)),
      swapBaseForQuote, slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint,
    });
    const out = BigInt(q?.outputAmount?.toString?.() ?? q?.amountOut?.toString?.() ?? 0);
    return out > 0n ? max : 0n;
  } catch { return 0n; }
}

/**
 * The largest value up to `upper` for which `fits` is true, assuming it is monotonic.
 *
 * Separated from the chain so the boundary behaviour can be pinned by a test with no RPC: an
 * off-by-one here hands a buyer a number that still will not fill, which is worse than the two
 * words it replaced because it looks like an answer.
 */
export async function searchMax(fits, upper) {
  let hi = BigInt(upper);
  if (hi <= 0n) return 0n;
  if (await fits(hi)) return hi;  // everything they asked for fits; no search needed
  if (!(await fits(1n))) return 0n;   // not even one unit
  let lo = 1n;
  // Invariant: `lo` fits and `hi` does not, so the answer is lo once they are adjacent.
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (await fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

export async function quoteSwap({ conn, pool, amountIn, swapBaseForQuote, slippageBps = 100 }) {
  const c = await client(conn);
  // The service method rather than the bare helper: it assembles the pool, the config and the
  // current slot itself, which is three places fewer to get wrong on every quote.
  const { SwapMode } = await sdk();
  // swapQuote2 takes the fetched ACCOUNTS, not addresses, and the current slot — it prices against
  // the fee scheduler, so an anti-snipe decaying fee quotes correctly in the seconds it is still
  // high rather than quoting the settled fee and under-charging the quote the user is shown.
  // getPool returns a WRAPPER, { poolState: … }, and swapQuote2 wants that wrapper — internally it
  // reads `virtualPool.poolState.quoteReserve`. Unwrapping it first (the obvious move) fails deep
  // inside the SDK with an opaque "_bn"/"quoteReserve" error, so the wrapper is passed through
  // whole and only READ one level down.
  const virtualPool = await c.state.getPool(new PublicKey(pool));
  if (!virtualPool?.poolState?.config) throw new Error('pool not found, or its shape changed');
  // getPoolConfig, by contrast, returns the config account directly. The asymmetry is the SDK's.
  const config = await c.state.getPoolConfig(virtualPool.poolState.config);
  if (!config?.quoteMint) throw new Error('pool config unreadable, or its shape changed');
  const currentPoint = new BN(await conn.getSlot());
  const q = await c.pool.swapQuote2({
    virtualPool, config,
    // ExactIn: "I am spending this much, tell me what I get" — what a buy box actually asks.
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(String(amountIn)),
    swapBaseForQuote, slippageBps, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  const n = (v) => { try { return BigInt(v?.toString?.() ?? v ?? 0); } catch { return 0n; } };
  return {
    out: n(q.outputAmount ?? q.amountOut),
    minOut: n(q.minimumAmountOut),
    fee: n(q.fee?.trading ?? q.tradingFee),
  };
}

/**
 * Does this pool's base mint carry a transfer hook?
 *
 * ⛔ ASKED OF THE MINT, NOT OF OUR DATABASE. A hooked coin swapped through the ordinary `swap`
 * entry point is missing the hook's own accounts, and the token program refuses the transfer — so
 * the coin would be listed, charted and completely untradeable, which is the exact failure $REXWEEN
 * had for a different reason and the one thing this venue cannot afford twice. Our own `venue`
 * column would answer for coins we launched; it would say nothing about a pool we indexed, and it
 * would be wrong for ever if a row were ever written badly. The mint cannot be wrong about itself.
 */
const hookCache = new Map();   // mint -> { at, hook }
const HOOK_TTL = Number(process.env.HOOK_TTL_MS || 300_000);

export async function hookOfMint(conn, mint) {
  const key = String(mint);
  // ⛔ THIS IS ON THE HOT PATH: every buy and every sell builds a swap, and without a cache each one
  // costs an extra getAccountInfo — plus a getMint for Token-2022 coins — on an RPC that ran out of
  // allowance twice today. A mint's owning program can never change, and our own mints are created
  // with an immutable authority so their hook cannot either; five minutes is cautious for a mint
  // somebody else controls and still turns a per-trade cost into a per-coin one.
  const hit = hookCache.get(key);
  if (hit && Date.now() - hit.at < HOOK_TTL) return hit.hook;
  const pk = new PublicKey(key);
  const info = await conn.getAccountInfo(pk);
  let hook = null;
  if (info && info.owner.toBase58() === TOKEN_2022) {     // only Token-2022 can carry one
    const { getMint, getTransferHook } = await import('@solana/spl-token');
    const m = await getMint(conn, pk, 'confirmed', new PublicKey(TOKEN_2022));
    const id = getTransferHook(m)?.programId?.toBase58?.();
    // An all-zero program id is the extension present but switched off, which is not a hook.
    if (id && id !== PublicKey.default.toBase58()) hook = id;
  }
  hookCache.set(key, { at: Date.now(), hook });
  return hook;
}
/** For tests, and for anyone who has just watched a mint's hook authority change it. */
export const forgetHooks = () => hookCache.clear();

export async function buildSwap({ conn, owner, pool, amountIn, minimumAmountOut, swapBaseForQuote, baseMint = null }) {
  const c = await client(conn);
  const params = {
    owner: new PublicKey(owner), pool: new PublicKey(pool),
    amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)),
    swapBaseForQuote, referralTokenAccount: null,
  };
  // A hooked pool needs the hook-aware entry point, which resolves the extra accounts the hook
  // program demands and threads them onto the instruction. The caller passes the base mint when it
  // knows it; without it we cannot ask, and the plain path is the right default for the SPL mints
  // that are the overwhelming majority.
  // ⛔ A FAILED CHECK IS NOT "NOT HOOKED". Swallowing the error and taking the plain path builds a
  // swap that the token program will refuse on chain, and the trader sees a revert they cannot
  // explain instead of a sentence they can. Refuse in words; the cache means this is rare.
  let hook = null;
  if (baseMint) {
    try { hook = await hookOfMint(conn, baseMint); }
    catch (e) { throw new Error(`could not check whether this coin has transfer rules, so the swap cannot be built safely (${e.message})`); }
  }
  if (!hook) return c.pool.swap(params);
  const { SwapMode } = await sdk();
  return c.pool.swap2WithTransferHook({ ...params, swapMode: SwapMode.ExactIn });
}

/**
 * A DBC swap, packed and ready for a wallet to sign.
 *
 * ⛔ WHY THIS EXISTS: `quoteSwap` and `buildSwap` above were written when the venue was built and
 * then never wired to anything. The consequence only became visible when the first coin actually
 * reached Meteora: $REXWEEN launched, DexScreener indexed it within minutes — and it could not be
 * bought ANYWHERE. Not on our own site, because the buy box only knew our own curve program; and
 * not on Jupiter or any terminal, because an aggregator will not route through a pool whose real
 * quote reserve is still zero. A fresh DBC curve has no real reserves until someone trades, so the
 * FIRST trade can only happen on the launchpad itself. With no route here, that first trade was
 * impossible and every Meteora launch was permanently untradeable.
 *
 * The swap instruction comes from the SDK; everything around it is the same as our own venue, so
 * the wrapping rules are imported rather than written twice:
 *  - a buy spends the quote asset, so native SOL has to be wrapped first and unwrapped after;
 *  - a sell spends the base token and RECEIVES quote, so the quote account must exist beforehand —
 *    without it the swap fails on an account that does not exist yet, which reads like a pool bug.
 */
export async function buildSwapTx({ conn, owner, pool, quoteMint, baseMint = null, amountIn, minimumAmountOut, swapBaseForQuote }) {
  const CH = await import('./chain.mjs');
  // The base mint travels this far purely so the swap can ask whether the coin is hooked. A hooked
  // coin swapped through the plain entry point is a coin nobody can buy or sell.
  const swap = await buildSwap({ conn, owner, pool, amountIn, minimumAmountOut, swapBaseForQuote, baseMint });
  const inner = swap.instructions ?? [swap];
  // Add only the wrapped-SOL handling the SDK has not already built. Doing it unconditionally made
  // every SOL-paired coin unbuyable — see wrapperForSwap.
  const { pre, post } = wrapperForSwap(CH, inner, quoteMint, owner, {
    amountIn,
    prog: new PublicKey(await quoteProgramOf(conn, quoteMint)),
    receivesQuote: swapBaseForQuote,
  });
  return { tx: await CH.packTx([...pre, ...inner, ...post], owner) };
}

/** Which token program a quote mint lives under — $REX is Token-2022, SOL and USDC are not, and an
 *  ATA derived under the wrong one is a different address that the swap will not find. */
async function quoteProgramOf(conn, mint) {
  const CH = await import('./chain.mjs');
  return (await CH.tokenProgramOf(mint)).toBase58();
}

// ---------------------------------------------------------------- the creator's own fees
/**
 * What this pool currently owes its creator, read from the pool account.
 *
 * On our own curve the creator's share accrues into `creator_pot` in our database, because our
 * program splits every swap into five buckets we control. On Meteora it accrues ON THE POOL as
 * `creatorQuoteFee` / `creatorBaseFee` — the chain is the ledger, and our database never sees it.
 * A dashboard that reported the DB figure for a DBC coin would confidently show zero while real
 * money sat on the pool: $REXWEEN had 193.84 REX waiting on it while our `trades` count said 0.
 *
 * Returns raw base units; null when the pool cannot be read, which is UNKNOWN and not zero.
 */
export async function creatorFeesOf(conn, pool) {
  try {
    const c = await client(conn);
    const p = await c.state.getPool(new PublicKey(pool));
    const st = p?.poolState;
    if (!st) return null;
    const n = (v) => { try { return BigInt(v?.toString?.() ?? v ?? 0); } catch { return 0n; } };
    return { base: n(st.creatorBaseFee), quote: n(st.creatorQuoteFee), creator: st.creator?.toBase58?.() || null };
  } catch (e) { warn('creatorFeesOf', e.message); return null; }
}

/**
 * What this transaction actually needs in the fee payer's wallet, in lamports.
 *
 * ⛔ THE FIRST SHORTFALL A SIMULATOR REPORTS IS NOT THE TOTAL. A creator claim opens TWO accounts,
 * one for the base and one for the quote, and the simulation stops at whichever it reaches first —
 * so its "need 1488440" is the rent for ONE of them. I read that number straight out of the logs
 * and told seven launchers to send 0.003 SOL. They did. Six of them were still short, because the
 * real cost is two rents PLUS the payer's own rent-exempt floor, which it may not drop below.
 *
 * Counted from the instructions instead: every associated-token create in the transaction, at the
 * rent its own token program charges, plus the payer's floor, plus the fee. Over-stating slightly
 * is the safe direction — under-stating is what sent people back to the faucet twice.
 */
async function lamportsNeeded(conn, ixProgramIds, payer) {
  const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const creates = ixProgramIds.filter((p) => p === ATA).length;
  // A Token-2022 account is the larger of the two; use it so the figure is never short.
  const [perAccount, floor] = await Promise.all([
    conn.getMinimumBalanceForRentExemption(170),
    conn.getMinimumBalanceForRentExemption(0),
  ]);
  const have = await conn.getBalance(new PublicKey(payer), 'confirmed');
  const need = creates * perAccount + floor + 10_000;        // 10k covers the signature comfortably
  return { creates, perAccount, floor, have, need };
}

/**
 * Simulate a transaction we are about to hand a wallet, and say in WORDS what is wrong with it.
 *
 * ⛔ A WALLET'S SIMULATION DUMP IS NOT AN ERROR MESSAGE. A launcher photographed this and sent it
 * in: "Simulation failed. Message: Transaction simulation failed: Error processing Instruction 6:
 * invalid account data for instruction. Logs: [ Program dbcij3LWUpp… ]" and six hundred more
 * characters of compute-unit accounting. It tells them nothing they can act on, it reaches us as a
 * photograph of a phone, and it is the second time this exact shape has been reported.
 *
 * Simulating here costs one RPC call and turns both of the failures actually seen into a sentence:
 * a duplicate close (now fixed) and — the commoner one by far — a creator whose wallet cannot
 * cover the RENT for the token accounts the claim has to open. Seven of the thirty-five pools with
 * fees accrued fail for that reason alone, and nothing in the old path said so.
 *
 * Returns null when it simulates clean, or a plain-English reason not to send it.
 */
export async function explainBeforeSending(conn, txBase64, opts = {}) {
  return (await inspectBeforeSending(conn, txBase64, opts)).why;
}

/**
 * The same check, but saying whether it could RUN.
 *
 * ⛔ "I COULD NOT CHECK" IS NOT "IT IS FINE", AND CONFLATING THEM HID FIVE BLOCKED LAUNCHERS.
 * explainBeforeSending answers null both for a transaction that simulates clean and for one it
 * could not simulate at all — deliberately, because an unreachable RPC must not block a good
 * claim. But the top-up planner read that null as "their claim works", so a moment of RPC
 * pressure turned five launchers who cannot claim into "nothing to fund", and the owner pressed a
 * button that did nothing. Anything DECIDING something off this needs `checked`.
 */
export async function inspectBeforeSending(conn, txBase64, { action = 'claim' } = {}) {
  const { VersionedTransaction, Transaction } = await import('@solana/web3.js');
  const buf = Buffer.from(txBase64, 'base64');
  let sim, programIds = [], payer = null;
  try {
    let vt = null;
    try { vt = VersionedTransaction.deserialize(buf); } catch { /* legacy */ }
    if (vt) {
      const keys = vt.message.staticAccountKeys;
      programIds = vt.message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58());
      payer = keys[0]?.toBase58() ?? null;
    } else {
      const legacy = Transaction.from(buf);
      programIds = legacy.instructions.map((ix) => ix.programId.toBase58());
      payer = legacy.feePayer?.toBase58() ?? null;
    }
    sim = await conn.simulateTransaction(vt || Transaction.from(buf),
      vt ? { sigVerify: false, replaceRecentBlockhash: true } : { sigVerify: false });
  } catch (e) {
    // ⛔ A SIMULATION WE COULD NOT RUN IS NOT A TRANSACTION WE KNOW IS BAD. Let it through: the
    // wallet will simulate too, and refusing on our own RPC trouble would block good claims.
    warn('simulate', e.message);
    return { checked: false, why: null };
  }
  if (!sim?.value?.err) return { checked: true, why: null };
  const logs = sim.value.logs || [];
  const errStr = JSON.stringify(sim.value.err || '');
  // Every way the chain says "this wallet cannot afford it" — a System transfer refusing with
  // Custom:1 under the associated-token program, or the payer itself falling below its own
  // rent-exempt floor, which is a different error shape entirely and used to fall through to the
  // useless generic branch.
  const skint = /insufficient lamports/i.test(logs.join(' ')) || /InsufficientFundsForRent/.test(errStr);
  if (skint) {
    try {
      const n = await lamportsNeeded(conn, programIds, payer);
      const short = Math.max(0, n.need - n.have);
      if (short > 0) {
        const s3 = (l) => (l / 1e9).toFixed(5);
        return { checked: true, why: `This ${action} opens ${n.creates} token account${n.creates === 1 ? '' : 's'} for you, and`
          + ` between their rent, the network fee and the minimum this wallet must keep to stay open,`
          + ` it needs about ${s3(n.need)} SOL. It holds ${s3(n.have)} SOL.`
          + ` Send it ${(Math.ceil(short / 1e6) / 1e3).toFixed(3)} SOL more and try again —`
          + ' the rent comes back if those accounts are ever closed.' };
      }
    } catch (e) { warn('lamportsNeeded', e.message); }
  }
  // ⛔ A WALLET WITH NO LAMPORTS DOES NOT EXIST ON CHAIN, and the error for that is a bare string
  // rather than an InstructionError — so it falls past every log-based check and out of the
  // generic branch as "would fail on chain", which is true and useless. Two of the nine creators
  // who still cannot claim are in exactly this state: never funded, not one lamport.
  if (sim.value.err === 'AccountNotFound' || /AccountNotFound/.test(String(sim.value.err))) {
    return { checked: true, why: 'This wallet holds no SOL at all, so it cannot pay the network fee or the rent for the'
      + ` token account this ${action} needs. Send it about 0.003 SOL and try again.` };
  }
  // Reached only when the balance could not be read; the figure above is the one people act on.
  if (skint) return `This wallet does not hold enough SOL to pay for the accounts this ${action} opens.`;
  // A thin, fast curve moves between the quote and the signature, which is exactly when people
  // are trying hardest to buy. Say that plainly rather than showing them a slippage error.
  if (logs.some((l) => /[Ss]lippage|ExceededSlippage|amount is less than min/.test(l))) {
    return { checked: true, why: 'The price moved between your quote and this transaction, so it would have filled worse'
      + ' than the limit you set. Nothing was sent. Try again, or raise your slippage.' };
  }
  if (logs.some((l) => /InvalidAccountData/.test(l))) {
    return { checked: true, why: `One of the accounts this ${action} needs is not in the state the program expects.`
      + ' This has been reported — nothing has been sent and nothing is lost. Please tell us the coin.' };
  }
  const failed = logs.filter((l) => /failed:/.test(l)).pop();
  return { checked: true, why: `This ${action} would fail on chain${failed ? `: ${failed.replace(/^Program \S+ /, '')}` : ''}.`
    + ' Nothing was sent.' };
}

/**
 * ⛔ DO NOT ADD A SECOND CLOSE FOR A WRAPPER THE SDK ALREADY CLOSES.
 *
 * `claimCreatorTradingFee` builds its own wrapped-SOL handling: it creates the receiver's ATAs and
 * closes the wrapper afterwards. We were appending our own open/close around it, so a SOL-quoted
 * creator claim carried TWO CloseAccount instructions — the second one acting on the account the
 * first had just closed. The token program answers that with `InvalidAccountData`, which surfaces
 * in a wallet as "Error processing Instruction 6: invalid account data for instruction" and tells
 * the launcher nothing at all. A launcher photographed exactly that on 10 Oct; simulating every
 * pool with fees accrued found 8 more failing the same way, on every SOL-quoted pool whose creator
 * had enough SOL to reach the close.
 *
 * The half-missing version of this — a close with nothing to open it — was the opposite bug, fixed
 * a few days earlier. Hard-coding either answer is how it oscillates. So ASK THE INSTRUCTIONS:
 * add only the half the SDK has not already provided, which stays right if the SDK changes again.
 */
/**
 * What the SDK's own instructions already do with the user's wrapped-SOL account.
 *
 * `opens`  — the associated-token account is created (ATA program, new account is key 1).
 * `funds`  — lamports are moved into it and synced (System transfer to it, or SyncNative = ix 17).
 * `closes` — it is closed again (SPL CloseAccount = ix 9, first key is the account).
 */
export function sdkWrapper(inner, user) {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(user), true, TOKEN_PROGRAM_ID).toBase58();
  const keyAt = (ix, i) => (ix.keys?.[i]?.pubkey ?? ix.keys?.[i])?.toBase58?.();
  const isToken = (ix) => ix.programId?.equals?.(TOKEN_PROGRAM_ID);
  return {
    opens: inner.some((ix) => ix.programId?.equals?.(ASSOCIATED_TOKEN_PROGRAM_ID) && keyAt(ix, 1) === wsol),
    funds: inner.some((ix) => (ix.programId?.equals?.(SystemProgram.programId) && keyAt(ix, 1) === wsol)
      || (isToken(ix) && ix.data?.length === 1 && ix.data[0] === 17 && keyAt(ix, 0) === wsol)),
    closes: inner.some((ix) => isToken(ix) && ix.data?.length === 1 && ix.data[0] === 9 && keyAt(ix, 0) === wsol),
  };
}

export function wrapperAround(CH, inner, quoteMint, user) {
  if (!CH.isNative(quoteMint)) return { prefix: CH.quoteOutPrefix(quoteMint, user), suffix: [] };
  const w = sdkWrapper(inner, user);
  return {
    prefix: w.opens ? [] : CH.quoteOutPrefix(quoteMint, user),
    suffix: w.closes ? [] : CH.quoteOutSuffix(quoteMint, user),
  };
}

/**
 * The same question for a SWAP, which SPENDS quote rather than receiving it.
 *
 * ⛔ THIS IS WHY SOL-PAIRED COINS COULD NOT BE BOUGHT AT ALL. The SDK's swap builder does the whole
 * wrapped-SOL dance itself, and we did it again around the outside, so a SOL-quoted buy went out as
 *
 *   0:ATA 1:SYS 2:TOKEN  3:ATA 4:SYS 5:TOKEN  6:DBC  7:TOKEN 8:TOKEN
 *   └── ours ──────────┘ └── the SDK's ────┘        └ its close, then ours
 *
 * and died at instruction 8 with InvalidAccountData, closing an account already closed. Simulating
 * a buy on all 66 live pools found 17 like this — every SOL-quoted coin on the site. The team
 * reported it as "fomo doesn't let sometimes buy"; "sometimes" was "whenever the pair is SOL".
 *
 * The doubled WRAP mattered too, even though the lamports come back on the close: the buyer had to
 * hold twice the amount they were spending for the transaction to get that far, so the bigger the
 * buy the more certainly it failed — which is exactly what a FOMO buy is.
 */
export function wrapperForSwap(CH, inner, quoteMint, user, { amountIn, prog, receivesQuote }) {
  if (!CH.isNative(quoteMint)) {
    return {
      pre: receivesQuote ? [CH.ensureAtaIx(user, quoteMint, user, prog)] : CH.quoteInPrefix(quoteMint, user, amountIn, prog),
      post: [],
    };
  }
  const w = sdkWrapper(inner, user);
  const ready = receivesQuote ? w.opens : (w.opens && w.funds);
  return {
    pre: ready ? [] : (receivesQuote ? [CH.ensureAtaIx(user, quoteMint, user, prog)] : CH.quoteInPrefix(quoteMint, user, amountIn, prog)),
    post: w.closes ? [] : CH.quoteOutSuffix(quoteMint, user),
  };
}

/**
 * A signable transaction claiming those fees to the creator's own wallet.
 *
 * `maxBaseAmount` / `maxQuoteAmount` are CEILINGS, not amounts — the program pays out whatever has
 * accrued up to them, so passing the current balance claims everything without having to win a race
 * against a swap landing in the same block.
 */
export async function buildClaimCreatorTx({ conn, creator, pool, quoteMint, maxBase = 0n, maxQuote = 0n, pay = [] }) {
  const CH = await import('./chain.mjs');
  const c = await client(conn);
  const tx = await c.creator.claimCreatorTradingFee({
    creator: new PublicKey(creator), pool: new PublicKey(pool),
    maxBaseAmount: new BN(String(maxBase)), maxQuoteAmount: new BN(String(maxQuote)),
    receiver: new PublicKey(creator), payer: new PublicKey(creator),
  });
  const inner = tx.instructions ?? [tx];
  const { prefix, suffix } = wrapperAround(CH, inner, quoteMint, creator);
  // ⛔ THE SHARERS ARE PAID INSIDE THE CREATOR'S OWN CLAIM, so the two settle atomically: either
  // the creator receives their fee and the sharers receive their slice, or neither happens. The
  // alternative — taking the slice before the creator sees it — means routing their money through
  // us, which is custody of other people's funds for a referral feature.
  const share = await shareTransfers({ conn, quoteMint, creator, pay });
  return { tx: await CH.packTx([...prefix, ...inner, ...suffix, ...share], creator), paying: pay || [] };
}

/**
 * Transfers paying each sharer their slice, appended AFTER the claim.
 *
 * ⛔ AFTER THE UNWRAP, NOT BEFORE IT. On a SOL-quoted pool the claim pays wrapped SOL and then
 * CLOSES the wrapper, so by the end of the claim the money is native lamports in the creator's
 * wallet — a token transfer there would find an account that no longer exists. Native pays with a
 * system transfer and costs the sharers no rent at all; every other quote needs their associated
 * token account to exist, and the creator pays that rent.
 */
async function shareTransfers({ conn, quoteMint, creator, pay }) {
  if (!pay?.length) return [];
  const { SystemProgram } = await import('@solana/web3.js');
  const from = new PublicKey(creator);
  if (isNativeQuote(quoteMint)) {
    return pay.map((r) => SystemProgram.transfer({
      fromPubkey: from, toPubkey: new PublicKey(r.referrer), lamports: BigInt(r.amountRaw),
    }));
  }
  const CH = await import('./chain.mjs');
  const prog = await CH.tokenProgramOf(quoteMint);
  const mint = new PublicKey(quoteMint);
  const src = getAssociatedTokenAddressSync(mint, from, true, prog);
  const dec = await quoteDecimalsOf(conn, quoteMint);
  if (!Number.isInteger(dec)) throw new Error('could not read the pair token decimals, so the sharers\' cut cannot be sized');
  const out = [];
  for (const r of pay) {
    const to = new PublicKey(r.referrer);
    const ata = getAssociatedTokenAddressSync(mint, to, true, prog);
    out.push(createAssociatedTokenAccountIdempotentInstruction(from, ata, to, mint, prog));
    out.push(createTransferCheckedInstruction(src, mint, ata, from, BigInt(r.amountRaw), dec, [], prog));
  }
  return out;
}
const isNativeQuote = (m) => String(m) === NATIVE_MINT.toBase58();

/** A pool's two vault accounts, so they can be told apart from real holders. */
export async function poolVaultsOf(conn, pool) {
  try {
    const c = await client(conn);
    const st = (await c.state.getPool(new PublicKey(pool)))?.poolState;
    return st ? { base: st.baseVault?.toBase58?.() || null, quote: st.quoteVault?.toBase58?.() || null } : null;
  } catch (e) { warn('poolVaultsOf', e.message); return null; }
}

// ---------------------------------------------------------------- live numbers for the board
/**
 * Price, reserves and curve fill for a live DBC pool, from ONE account read.
 *
 * ⛔ WHY THIS HAS TO EXIST: nothing on this site indexes Meteora swaps. A coin on the `dbc` venue
 * therefore sat at price 0 for ever — and because mcap is `price * supply`, the whole board read
 * $0 market cap, $0 liquidity, 0% curve for a coin that had genuinely traded 320 times and held
 * 12.8M REX. Elio called $BITE at $10.7K while our own pairs page showed it at zero.
 *
 * DexScreener is not a usable substitute here: it counts the transactions on these pools but
 * returns null for price, mcap and liquidity, because the pair is quoted in $REX. The chain is the
 * only honest source, which is what the site claims anyway.
 *
 * DBC stores a Q64.64 SQRT price, so the price is that value squared, scaled by the decimal gap
 * between the two mints. Verified against $BITE: 0.07274349 REX per token = $10,053 mcap, against
 * an average paid of 0.0584 — spot above average on a rising curve, as it must be.
 */
/**
 * ⛔ NO DEFAULT FOR THE QUOTE'S DECIMALS. A default of 6 is not a sensible fallback here, it is a
 * silent factor of a thousand: SOL and STONK are 9, every xStock and ZEC are 8, Monero is 12. The
 * caller that forgets to pass it does not get a slightly-wrong price, it gets one that is out by
 * three orders of magnitude, in the column the board and every portfolio read. Make it required
 * and the mistake becomes a crash in a test rather than a number nobody can explain.
 */
export async function poolStatsOf(conn, pool, { baseDecimals = 6, quoteDecimals } = {}) {
  if (!Number.isInteger(quoteDecimals)) throw new Error('poolStatsOf needs the quote decimals — read them from the mint, never assume 6');
  try {
    const c = await client(conn);
    const st = (await c.state.getPool(new PublicKey(pool)))?.poolState;
    if (!st) return null;
    const num = (v) => Number(v?.toString?.() ?? 0);
    const sp = num(st.sqrtPrice) / 2 ** 64;
    return {
      price: sp * sp * 10 ** (baseDecimals - quoteDecimals),   // quote per base
      quoteReserve: num(st.quoteReserve) / 10 ** quoteDecimals,
      baseReserve: num(st.baseReserve) / 10 ** baseDecimals,
      migrated: Boolean(st.isMigrated),
      migrationProgress: st.migrationProgress ?? 0,
      // Taken from the POOL, not from our own column. The graduation threshold lives on the config,
      // and pairing a pool's reserves with some other pool's threshold yields a curve "106442%
      // full" — which is exactly what happened the first time this was computed from a stored id.
      config: st.config?.toBase58?.() || null,
    };
  } catch (e) { warn('poolStatsOf', e.message); return null; }
}

/** The raise that graduates a pool, from its config. Immutable once created, so cache it. */
const _thresholds = new Map();
export async function migrationThresholdOf(conn, config, quoteDecimals) {
  if (!Number.isInteger(quoteDecimals)) throw new Error('migrationThresholdOf needs the quote decimals — read them from the mint, never assume 6');
  const key = String(config);
  if (_thresholds.has(key)) return _thresholds.get(key);
  try {
    const c = await client(conn);
    const cfg = await c.state.getPoolConfig(new PublicKey(key));
    const v = Number(cfg?.migrationQuoteThreshold?.toString() ?? 0) / 10 ** quoteDecimals;
    if (v > 0) _thresholds.set(key, v);
    return v > 0 ? v : null;
  } catch (e) { warn('migrationThresholdOf', e.message); return null; }
}

// ---------------------------------------------------------------- REX Chain's own cut
/**
 * What a pool owes REX CHAIN, as opposed to the coin's launcher.
 *
 * A DBC swap fee splits three ways on the pool account — creator, partner, protocol — and REX Chain
 * is the PARTNER. `creatorFeesOf` above is the launcher's money and this is ours; they are different
 * fields on the same account and confusing them would show a launcher the protocol's income or pay
 * the protocol's cut to a launcher. Measured on $REXWEEN: creator 193.845, partner 193.845,
 * Meteora's own protocol leg 96.922 — so the split in force is 40/40/20.
 *
 * Returns raw base units; null when the pool cannot be read, which is UNKNOWN and not zero.
 */
export async function partnerFeesOf(conn, pool) {
  try {
    const c = await client(conn);
    const p = await c.state.getPool(new PublicKey(pool));
    const st = p?.poolState;
    if (!st) return null;
    const n = (v) => { try { return BigInt(v?.toString?.() ?? v ?? 0); } catch { return 0n; } };
    return { base: n(st.partnerBaseFee), quote: n(st.partnerQuoteFee) };
  } catch (e) { warn('partnerFeesOf', e.message); return null; }
}

/** Who is allowed to claim the partner side, read from the pool's CONFIG rather than assumed. */
export async function feeClaimerOf(conn, config) {
  try {
    const c = await client(conn);
    const pc = await c.state.getPoolConfig(new PublicKey(config));
    return pc?.feeClaimer?.toBase58?.() || null;
  } catch (e) { warn('feeClaimerOf', e.message); return null; }
}

export async function buildClaimPartnerTx({ conn, feeClaimer, pool, quoteMint, maxBase = 0n, maxQuote = 0n }) {
  const CH = await import('./chain.mjs');
  const c = await client(conn);
  const tx = await c.partner.claimPartnerTradingFee({
    feeClaimer: new PublicKey(feeClaimer), payer: new PublicKey(feeClaimer), pool: new PublicKey(pool),
    maxBaseAmount: new BN(String(maxBase)), maxQuoteAmount: new BN(String(maxQuote)),
    receiver: new PublicKey(feeClaimer),
  });
  const inner = tx.instructions ?? [tx];
  // The same question as the creator claim above, asked of this path's own instructions rather
  // than assumed: the protocol's claim is the one we most want to collect from, and the SDK does
  // not necessarily build both paths the same way.
  const { prefix, suffix } = wrapperAround(CH, inner, quoteMint, feeClaimer);
  return { tx: await CH.packTx([...prefix, ...inner, ...suffix], feeClaimer) };
}

// ---------------------------------------------------------------- reading state
/** Every pool created under one of our configs. This is what the indexer walks. */
export async function poolsOfConfig(conn, config) {
  const c = await client(conn);
  return c.state.getPoolsByConfig(new PublicKey(config));
}

/**
 * A pool's address, derived rather than searched.
 *
 * `getPoolByBaseMint` scans program accounts and lags for a few seconds after creation, so a launch
 * that had just succeeded looked like it had failed. The address is a PDA of (quote, base, config)
 * and all three are known at launch time, so deriving it is both instant and correct immediately.
 */
export async function poolAddress(quoteMint, baseMint, config) {
  const { deriveDbcPoolAddress } = await sdk();
  return deriveDbcPoolAddress(new PublicKey(quoteMint), new PublicKey(baseMint), new PublicKey(config)).toBase58();
}

/** Fallback lookup for a mint whose config we do not have to hand. Scans, so it can lag. */
export async function poolOfMint(conn, mint) {
  const c = await client(conn);
  const r = await c.state.getPoolByBaseMint(new PublicKey(mint)).catch(() => null);
  return r?.publicKey ? r.publicKey.toBase58() : null;
}

/**
 * What a pool has accrued and not yet paid out, in base units.
 *
 * Read fresh every time and never cached. These numbers decide how much money moves, and a cached
 * fee figure is a double-payment waiting for a restart.
 */
export async function feesOf(conn, pool) {
  const c = await client(conn);
  // getPoolFeeMetrics, not getPool. The raw pool account does not expose the unclaimed fee under the
  // names you would expect, and reading it directly returned a confident zero while the pool had
  // real money in it — which is the worst possible failure for a crank, because nothing looks wrong.
  const m = await c.state.getPoolFeeMetrics(new PublicKey(pool)).catch(() => null);
  if (!m) return null;
  const n = (v) => { try { return BigInt(v?.toString?.() ?? v ?? 0); } catch { return 0n; } };
  const cur = m.current || {};
  const tot = m.total || {};
  return {
    partnerQuote: n(cur.partnerQuoteFee), partnerBase: n(cur.partnerBaseFee),
    creatorQuote: n(cur.creatorQuoteFee), creatorBase: n(cur.creatorBaseFee),
    totalQuote: n(tot.totalTradingQuoteFee), totalBase: n(tot.totalTradingBaseFee),
  };
}

/**
 * A pool's live reserves and price.
 *
 * Price is derived from the pool's own reserves, not from any curve maths of ours. The pool is the
 * authority on price now; computing it ourselves would be inventing a second answer that drifts.
 */
/*
 * poolState lived here and is deleted with its only caller.
 *
 * It was a second answer to "what is this pool's price", and it disagreed with poolStatsOf — which
 * reads sqrtPrice and scales by both decimals, and is the one the site actually runs. Two functions
 * computing the same number differently is how a site ends up unable to say which figure is true.
 * One of them was right; this was the other one.
 */

/** A quote mint's decimals, read from the chain and cached. The one source of truth for this. */
const qdCache = new Map();
export async function quoteDecimalsOf(conn, mint) {
  const k = String(mint);
  if (qdCache.has(k)) return qdCache.get(k);
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(k));
    const d = info?.value?.data?.parsed?.info?.decimals;
    // Never cache an unknown: a failed read would make every later price wrong for the life of
    // the process, which is worse than asking again.
    if (Number.isInteger(d)) { qdCache.set(k, d); return d; }
  } catch (e) { warn('quote decimals', e.message); }
  return null;
}

// ---------------------------------------------------------------- claiming
/**
 * Claim REX Chain's side of a pool's trading fee.
 *
 * `maxBaseAmount` / `maxQuoteAmount` are caps, not amounts — passing the exact accrued figure read
 * a moment ago would fail the instant one more trade lands between the read and the signature, so
 * both are set to the accrued amount and the program pays what is actually there.
 */
export async function buildClaimPartnerFee({ conn, feeClaimer, pool, maxBase, maxQuote, receiver }) {
  const c = await client(conn);
  return c.partner.claimPartnerTradingFee({
    feeClaimer: new PublicKey(feeClaimer),
    payer: new PublicKey(feeClaimer),
    pool: new PublicKey(pool),
    maxBaseAmount: new BN(String(maxBase)),
    maxQuoteAmount: new BN(String(maxQuote)),
    ...(receiver ? { receiver: new PublicKey(receiver) } : {}),
  });
}

/** The launcher's side. Signed by the launcher, never by us — it is their money. */
export async function buildClaimCreatorFee({ conn, creator, pool, maxBase, maxQuote, receiver }) {
  const c = await client(conn);
  return c.creator.claimCreatorTradingFee({
    creator: new PublicKey(creator),
    payer: new PublicKey(creator),
    pool: new PublicKey(pool),
    maxBaseAmount: new BN(String(maxBase)),
    maxQuoteAmount: new BN(String(maxQuote)),
    ...(receiver ? { receiver: new PublicKey(receiver) } : {}),
  });
}

// ---------------------------------------------------------------- graduation
/** Migrate a filled curve into a locked DAMM v2 pool. DBC owns this path; we only trigger it. */
export async function buildMigrate({ conn, payer, pool }) {
  const c = await client(conn);
  return c.migration.migrateToDammV2({ payer: new PublicKey(payer), virtualPool: new PublicKey(pool) });
}

/** Where a launch can be seen once it exists. These links are the whole reason for the move. */
export function explorerLinks(mint) {
  return {
    dexscreener: `https://dexscreener.com/solana/${mint}`,
    jupiter: `https://jup.ag/swap/SOL-${mint}`,
    meteora: `https://launch.meteora.ag/token/${mint}`,
  };
}
