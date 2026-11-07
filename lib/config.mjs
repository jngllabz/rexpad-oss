import path from 'node:path';
const env = process.env;
// REX's own wallets, as Elio sent them on 3 Oct. Three of them, with three different jobs, so they
// are named here once rather than pasted into whatever needed one:
//   main     — REX's operating wallet
//   treasury — the non-redeemable treasury the vault leg accrues to
//   income   — where protocol income lands, which is what the Jupiter swap fee is
// None of these is the owner's development share: that is written on chain at genesis and is not a
// wallet this config can point anywhere.
export const REX_MAIN = process.env.REX_MAIN_WALLET || 'CPnTiY3Yik6UNezffCG8bWXHMeKN5F3wHonpvYdgHU3n';
export const REX_TREASURY = process.env.REX_TREASURY_WALLET || '5iRLrdf3CcuBfHuoDPzVtVzFgvom3qHZ2QswjBwdzcY2';
export const REX_INCOME = process.env.REX_INCOME_WALLET || '6m4GQR71nWcJVrGiwcfkz5eVBQQiDHRSkzTENjavTND6';

/**
 * A Privy id, or '' if what we were given cannot be one.
 *
 * Privy ids are lowercase alphanumeric (cuid-shaped, around 25 characters). An underscore, a space,
 * an angle bracket or the word "your" is not a typo in a real id — it is an unedited example, and
 * shipping it is worse than shipping nothing.
 */
const PRIVY_PLACEHOLDER = /^(your|paste|example|changeme|xxx|<|app[_-]?id$)/i;
function realPrivyId(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (PRIVY_PLACEHOLDER.test(s) || !/^[a-z0-9]{16,40}$/.test(s)) {
    // ⛔ console.warn, not warn(): this runs while `cfg` is being built, and `warn` is exported
    // further down this file, so it is still in its temporal dead zone here. Calling it would throw
    // a ReferenceError at import and take the whole server down over a config typo.
    console.warn(new Date().toISOString(), '⚠ privy',
      `⛔ PRIVY_APP_ID is "${s}", which cannot be a real Privy id — treating it as unset.`,
      'Left as-is it would draw an email sign-in box that fails for every visitor who tried it.',
      'Create the app at dashboard.privy.io and paste the id from App settings.');
    return '';
  }
  return s;
}

export const cfg = {
  port: Number(env.PORT || 5300),
  // Baked in by the image build (see Dockerfile's GIT_SHA arg and scripts/deploy.sh). 'unknown'
  // means somebody deployed without it, which the deploy script refuses to do — a version endpoint
  // that answers 'unknown' cannot gate anything.
  gitSha: env.GIT_SHA || 'unknown',
  dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
  dbName: env.DB_NAME || 'forge.sqlite',
  sim: env.SIM === '1',
  // Conviction Yield epoch: pool distributes every epoch, on a visible countdown.
  epochMs: Number(env.EPOCH_MS || 60 * 60 * 1000),
  // CONVICTION_SCALE speeds the hold-time ladder (1 = real hours; 120 = 1 h ladder step every 30 s) — demo only.
  convictionScale: Number(env.CONVICTION_SCALE || 1),
  // Paper faucet for new wallets (settlement layer is the next milestone — see README).
  // Paper-mode starting balances. Every quote asset the launch screen offers has to be in here, or
  // a META / Stocks pair is launchable but nobody in the demo can actually trade it. The amounts are
  // ~$1,000 each, derived from each asset's price at startup (see faucetFor below).
  faucet: { REX: 5_000_000, SOL: 25, USDC: 5000, GP: 3_000_000 },
  faucetUsd: Number(env.FAUCET_USD ?? 1000),
  adminToken: env.ADMIN_TOKEN || '',
  brand: 'REX Chain',
  // On-chain mode: set RPC_URL (and deploy the program) to run REX Chain against a real cluster.
  rpcUrl: env.RPC_URL || '',
  crankKey: env.CRANK_KEY || '',
  // The owner's revenue share on REX Chain's own cut, written into the config in the same transaction
  // that creates it — so there is no window in which anyone else could claim it first. Permanent
  // once written: no instruction in the program can lower, clear or redirect it.
  //
  // ⛔ 1000 bps = 10% of ALL protocol income. This was WRONG at 300 for a while: "10% of the
  // development allocation" was read as 10% x the 30% Development leg = 3%. Elio's spec is ten
  // POINTS of the whole, alongside his team's 20 — the two together are the 30% development
  // allocation, they are not a share of it.
  //
  // The split of 100% of protocol income: Cyrus 10 (this), Elio dev team 20, buyback 55, USDC
  // reserve 5, stonk.fun top-10 5, vault 5. `migrate_config` verifies the five legs sum to exactly
  // 10_000 minus this number, so the two can never drift apart silently.
  //
  // `set_partner` is one-shot and has already fired on both clusters, so correcting a live
  // deployment needs `raise_partner`, which is up-only by design.
  // Which deployment to talk to. The IDL carries an address, but it carries the address of whatever
  // cluster it was last built for — so a devnet IDL build would silently repoint mainnet on its next
  // deploy. The committed IDL is therefore the MAINNET one and devnet overrides it here.
  programId: env.PROGRAM_ID || null,
  // Meteora DBC. `feeClaimer` is the wallet DBC pays REX Chain's side of every pool fee to, and it
  // is the key the fee crank signs with — so it is the one wallet that must exist for any of the
  // new revenue to be collectable at all.
  // 'dbc' sends new launches to Meteora; anything else keeps the old curve. A setting rather than a
  // code path so it can be rolled back without a client deploy.
  launchVenue: env.LAUNCH_VENUE || 'rexpad',
  // ⛔ ADDITIONAL admin keys, not a copy of the payee list. The gate is derived from the chain —
  // whoever the config says gets paid may administrate — and that is right, because a gate kept in
  // a second place silently stops matching the money. But the owner's own wallet is not one of the
  // six legs: the partner leg is a different key. So they could not open their own admin page.
  // This ADDS keys to the chain-derived set and never replaces it, so the two cannot drift apart.
  adminWallets: String(env.ADMIN_WALLETS || '').split(',').map((s) => s.trim()).filter(Boolean),
  feeClaimer: env.FEE_CLAIMER || null,
  feeClaimerKey: env.FEE_CLAIMER_KEY || null,
  // What the vault DOES with its money. Fco's call, 4 Oct: "Deepest" — full-range liquidity on both
  // sides, which is the deepest book and the most fees. It is also the only strategy that needs the
  // TOKEN side, which means a market buy, so the crank plans it and refuses to place it unattended.
  vaultStrategy: env.VAULT_STRATEGY || 'both',
  vaultBidDepthPct: Number(env.VAULT_BID_DEPTH_PCT ?? 15),
  // Where REX Chain's OWN 5% vault leg goes. Fco, 4 Oct: "Deepen Rex" — into $REX's own liquidity
  // rather than into each launched coin, because a deeper $REX is the flywheel every launch feeds.
  vaultTarget: env.VAULT_TARGET || 'rex',
  // Which $REX pool that liquidity goes into. There is no safe default here: most $REX liquidity is
  // on PumpSwap, which we cannot LP into from this codebase, while the Meteora pool we CAN deposit
  // to is comparatively tiny. Set deliberately or the crank refuses rather than guessing.
  rexPool: env.REX_POOL || null,
  // A market buy against a thin book is how a vault donates to arbitrageurs. Above this the crank
  // stops and says so instead of filling.
  vaultMaxImpactPct: Number(env.VAULT_MAX_IMPACT_PCT ?? 3),
  // AI fee allocation. Entirely optional: with no key the deterministic policy in lib/ai_alloc.mjs
  // runs instead, so the feature works and is auditable without ever calling a model.
  aiKey: env.AI_API_KEY || null,
  aiUrl: env.AI_URL || 'https://api.anthropic.com/v1/messages',
  aiModel: env.AI_MODEL || 'claude-haiku-4-5-20251001',
  // The single pool fee for a new launch, and the launcher's share of it. These replace the five
  // freely-set sliders: a pool has one fee, and what used to be bucket percentages now describe how
  // REX Chain's half of it is divided after the claim.
  poolFeeBps: Number(env.POOL_FEE_BPS ?? 200),
  creatorSharePct: Number(env.CREATOR_SHARE_PCT ?? 50),
  // Minimum accrued fee worth a claim transaction. Below this the signature costs more than it
  // collects, and a crank that claims dust every minute is a crank that donates to validators.
  feeClaimMinUsd: Number(env.FEE_CLAIM_MIN_USD ?? 5),
  partnerWallet: env.PARTNER_WALLET || 'EGB6v3y5oS7Whv4KHYp8ksL2wRfqdfAF5Dbqq8kHXsZH',
  partnerBps: Number(env.PARTNER_BPS ?? 1000),
  // Whoever brings a CREATOR to the platform earns this share of that creator's own bucket, on every
  // token they ever launch. Self-funding: it does not touch holders, the vault, the burn or REX.
  creatorRefBps: Number(env.CREATOR_REF_BPS ?? 500),   // 5% of the referred creator's cut
  // A chat message costs nothing to send, so the floor that gates rewards also gates the room.
  chatFloorUsd: Number(env.CHAT_FLOOR_USD ?? 20),
  // Sybil resistance. A referral is PENDING until the referee proves they are a real participant:
  // real volume, still holding a while later. Until then it counts nowhere and pays nothing, so a
  // farm of fresh wallets inflates no leaderboard and earns no share.
  refVestVolumeUsd: Number(env.REF_VEST_VOLUME_USD ?? 50),
  refVestHoldSecs: Number(env.REF_VEST_HOLD_SECS ?? 600),
  refMaxPerDay: Number(env.REF_MAX_PER_DAY ?? 25),      // vested referrals per referrer per day
  // $REX a referrer must hold to earn. Checked when a referral vests AND again at every payout, so
  // qualifying once and then selling does not keep paying. 0 turns it off.
  refHoldUsd: Number(env.REF_HOLD_USD ?? 100),
  minEpochUsd: Number(env.MIN_EPOCH_USD ?? 0.05),
  // "The first epoch is short and published. It closes and pays what was collected. A zero page is a
  // bug." So the first epoch on a pair ignores the dust threshold and runs on its own short clock.
  firstEpochMs: Number(env.FIRST_EPOCH_MS || 10 * 60 * 1000), 
  // Devnet only: lets testers mint themselves the test quote asset. Never set this on mainnet.
  // The real $REX on mainnet. NOT the same as the quote mint the site trades against when it is
  // pointed at a test cluster — this is the one a person buys, so it never changes with the cluster.
  rexCa: env.REX_CA || 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump',
  // Privy embedded wallets. ⛔ BOTH ARE PUBLIC VALUES — an app id identifies the app to Privy's
  // API and is meant to ship in the client; there is no secret here and none must be added. With
  // no app id the client never even fetches the adapter, so the feature is genuinely absent rather
  // than present and broken.
  //
  // ⛔ AND A PLACEHOLDER MUST COUNT AS NO APP ID AT ALL. `PRIVY_APP_ID=your_app_id_here` was pasted
  // into production straight out of the instructions — the same way `RPC_URL=?api-key=YOUR_KEY` was
  // pasted three times, which is why checkRpcConfig exists further down this stack. The failure is
  // worse here: a truthy placeholder DRAWS the sign-in box, so every visitor gets an email field
  // that fails after they have typed their address into it, which is precisely the dead end the
  // whole "absent, not broken" design was for. A value that cannot possibly be real is treated as
  // absent, and said out loud at boot.
  privyAppId: realPrivyId(env.PRIVY_APP_ID),
  privyClientId: realPrivyId(env.PRIVY_CLIENT_ID),
  // "We need to add a little 2.5% from the total of holder rewards, to fund the op. Like stonk."
  // Taken off the reward pot before it is split, and paid to the operating wallet as one more leaf
  // in the same merkle tree the holders claim from — so it needs no change to the program and it is
  // as visible and as auditable as every other payout. Set OPS_BPS=0 to switch it off.
  opsBps: Number(env.OPS_BPS ?? 250),
  opsWallet: env.OPS_WALLET || REX_MAIN,
  rexMainWallet: REX_MAIN,
  rexTreasuryWallet: REX_TREASURY,
  rexIncomeWallet: REX_INCOME,
  // Jupiter swaps. Mainnet only — Jupiter has no devnet — so this RPC is deliberately its own and
  // does not follow rpcUrl. The fee is only charged when there is somewhere for it to land.
  jupRpc: env.JUP_RPC || 'https://api.mainnet-beta.solana.com',
  jupFeeWallet: env.JUP_FEE_WALLET || REX_INCOME,
  jupFeeBps: Number(env.JUP_FEE_BPS ?? 33),   // 0.33% of every swap — Elio's number, 3 Oct
  faucetMint: env.FAUCET_MINT || '',
  // Enough devnet SOL to create a launch and trade against it. Topped up only when a wallet is below
  // it, and never below the crank's own reserve.
  faucetSol: Number(env.FAUCET_SOL ?? 0.05),
  faucetAmount: Number(env.FAUCET_AMOUNT || 250_000), // pots below this roll into the next epoch // base58 secret key for the permissionless cranks (settle + post_epoch)
  rewardsBase: env.REWARDS_BASE || 'https://rex-rewards.fly.dev',
  // rex.fun's own access model: hold $REX in your wallet to unlock — a balance check, never a payment.
  // Anyone can launch. Holding $REX is rewarded with a better rate instead of being a gate:
  // a qualifying launch starts further down the REX fee schedule, which goes straight to its holders.
  launchHoldUsd: Number(env.LAUNCH_HOLD_USD ?? 0),
  rexRateHoldUsd: Number(env.REX_RATE_HOLD_USD ?? 500),   // hold this much $REX for the better rate
  rexRateSteps: Number(env.REX_RATE_STEPS ?? 2),          // how many 0.05% steps it takes off
  // A position worth less than this in the quote asset is skipped by an epoch, per the locked spec.
  rewardFloorUsd: Number(env.REWARD_FLOOR_USD ?? 20),
  // The verified Metaplex collection whose NFTs become a holder's profile picture. Unset means the
  // feature is simply off — no collection, no badge — rather than every NFT qualifying, which is
  // what an unset "match anything" would mean.
  rexNftCollection: env.REX_NFT_COLLECTION || '',
  // The coins in the featured bar, in the order they are shown. REX itself leads — a bar that
  // points at everything except the token the whole site runs on is a strange bar — and REXMARS
  // follows as the first real REX-quoted coin.
  //
  // They live on MAINNET while this site may be pointed at devnet, so everything that renders them
  // has to say so. An empty list means no bar at all. FEATURED_MINT (singular) still works, because
  // it is what is set on deployments that predate this.
  featuredMints: String(env.FEATURED_MINTS || env.FEATURED_MINT
    || 'CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump,4gpWnRwQum7Q71icZCCo8GXsZyCUP34YdKbEEQFRmpNE')
    .split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6),
  boostHoldUsd: Number(env.BOOST_HOLD_USD ?? 500),
  boostMult: Number(env.BOOST_MULT ?? 1.25),
};
export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), '⚠', ...a);
