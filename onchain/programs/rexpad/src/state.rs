use anchor_lang::prelude::*;

pub const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1B tokens at 6 decimals
pub const CURVE_TOKENS: u64 = 793_100_000_000_000; // sold on the curve
pub const LP_TOKENS: u64 = TOTAL_SUPPLY - CURVE_TOKENS; // locked into the AMM at graduation, never withdrawable
pub const V_TOKEN0: u128 = 1_073_000_000_000_000; // initial virtual token reserve
// --- Fee module, per the locked build spec -------------------------------------------------
// Four buckets, half-point steps, all taken in the QUOTE asset on SWAPS ONLY. A send pays zero,
// and the fee is never taken in the launched token. The sum is capped and each field has its
// own ceiling; the program rejects anything above either.
pub const FEE_STEP_BPS: u16 = 50;      // half a percent is a real setting
pub const HOLDER_MIN_BPS: u16 = 100;   // 1%
pub const HOLDER_MAX_BPS: u16 = 300;   // 3%
pub const SIDE_MAX_BPS: u16 = 100;     // creator / burn / buyback ceiling, 1% each
pub const VAULT_MAX_BPS: u16 = 200;    // Value / Vault runs to 2%
pub const FEE_CAP_BPS: u16 = 500;      // 5% hard ceiling — no launch configures an unlimited stack
// The REX protocol fee is an ABSOLUTE share of the trade, carved out of the holder allocation —
// not a fraction of it. It starts at 0.50% and steps down as the launch hits market-cap milestones,
// and the holder allocation rises by exactly as much as REX gives up.
pub const REX_TIER_LAUNCH_BPS: u16 = 50;  // 0.50% at launch
pub const REX_TIER_FLOOR_BPS: u16 = 20;   // 0.20% once fully stepped down
pub const REX_TIER_STEP_BPS: u16 = 5;     // 0.50 → 0.45 → 0.40 → 0.35 → 0.30 → 0.25 → 0.20
/// "Dev buy is escrowed into the same clear and capped." The memo does not name the number, so this
/// is ours: the creator may commit at most 20% of the raise target. It is enforced at commit time
/// (the only moment a cap is well defined — the clearing total does not exist until the bell), and
/// it is what stops a creator from being most of their own clear.
pub const DEV_COMMIT_MAX_BPS: u64 = 2_000;
/// Ceiling on the partner's share of REXPAD's cut, so a fat-fingered value cannot assign more
/// than the protocol earns.
pub const PARTNER_MAX_BPS: u16 = 5_000;
pub const BPS: u128 = 10_000;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    /// Two-step authority handover. `propose_authority` writes here and `accept_authority` — signed
    /// by the proposed key itself — promotes it. One step would let a typo brick the protocol
    /// permanently, since nothing else can post an epoch, sweep a bucket or move a REX tier.
    pub pending_authority: Pubkey,
    /// ⛔ LOAD-BEARING, DESPITE WHAT THIS COMMENT USED TO SAY. It read "kept for layout
    /// compatibility and unused: there is no platform fee", and the first half of that is simply
    /// wrong. There is indeed no platform fee — REXPAD is paid out of the holder bucket (`rex_bps`)
    /// alone — but this field is the authority every `SweepBucket` destination must belong to, and
    /// it is the only on-chain-named address swept buckets can reach. A reader who believed the old
    /// comment would treat it as dead weight and could reasonably reuse or ignore it.
    ///
    /// It is also written exactly once, at `init_config`, from an `UncheckedAccount`, with no
    /// setter and no two-step handover of the kind `pending_authority` above gets. A wrong or lost
    /// key here cannot be corrected, and every future sweep is stuck with it.
    pub fee_wallet: Pubkey,
    /// Revenue share on REXPAD's own cut. `partner_bps` of every REX-bucket sweep is paid straight
    /// to `partner` by the program, before the remainder reaches the treasury — so the share does
    /// not depend on anyone remembering to forward it. Terms can only be changed with the partner's
    /// own signature, and the partner can rotate their receiving wallet without the authority.
    pub partner: Pubkey,
    pub partner_bps: u16,
    /// ⛔ STORED, RANGE-CHECKED ON EVERY WRITE, AND NEVER READ BY ANYTHING. Both of these look
    /// like global ceilings on what a launch may charge — `init_config` and `set_config` validate
    /// them at <= 300 and <= 100 bps — but no fee computation consults either. Per-launch fees are
    /// bounded by `validate_fees` alone, and nothing reconciles the two. A reader who trusts these,
    /// including an auditor reading the state in good faith, concludes there is a protocol-wide cap
    /// in force that is not in force.
    ///
    /// Left in place rather than deleted because removing a field shifts every byte after it and
    /// this program is deployed and live; the honest fix is to enforce them inside `validate_fees`
    /// so the appearance and the behaviour agree, which is a behaviour change and the owner's call.
    /// Until then this comment is the disclosure.
    pub curve_fee_bps: u16,
    pub amm_fee_bps: u16,
    pub paused: bool,
    pub bump: u8,

    // ---------------------------------------------------------------- the waterfall
    //
    // Where REXPAD's own cut goes, split the moment it is paid out rather than by somebody
    // remembering to forward it. Each leg is a wallet the program will pay and NOTHING else, which
    // is what makes "a wallet for each" a fact rather than a policy.
    //
    // These are shares OF REX INCOME, the same 100% the partner share is measured against — so they
    // must sum to exactly `10_000 - partner_bps`, and `set_waterfall` refuses anything else. That
    // one check is what stops the split quietly adding up to 97% and leaving dust nobody owns.
    //
    // Appended to the END of the struct on purpose: existing config accounts were allocated before
    // these existed, so they are reached only after `migrate_config` has grown the account. Reading
    // them from an un-migrated config would deserialize garbage, which is why that instruction
    // treats the account as raw bytes rather than as a Config.
    pub dev2: Pubkey,
    pub dev2_bps: u16,
    pub buyback: Pubkey,
    pub buyback_bps: u16,
    pub usdc_reserve: Pubkey,
    pub usdc_bps: u16,
    pub plays: Pubkey,
    pub plays_bps: u16,
    pub vault: Pubkey,
    pub vault_bps: u16,
    /// 0 until `migrate_config` has run. Everything above this line predates the waterfall.
    pub waterfall_version: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug, Default)]
pub enum LaunchStatus {
    FairOpen,
    // `Live` is the default purely so the curve maths can be exercised from a zero-valued test
    // fixture: it is the state those functions actually run in. No real launch reaches this —
    // `create_launch` writes the status explicitly.
    #[default]
    Live,
    Graduated,
    /// Reserves released to a migrator, pool not yet proven. Only ever observable mid-transaction:
    /// if the proof does not land, the release that set this is reverted with it.
    Migrating,
    /// The reserves are in a Raydium CPMM pool and no LP exists. Trading happens there now, which is
    /// the whole point: a pool on a program the indexers already read.
    Migrated,
}

#[account]
// `Default` so the curve maths can be exercised in unit tests without hand-writing 33 fields for
// every case. It is a test affordance only: every real Launch is written by `create_launch`.
#[derive(InitSpace, Default)]
pub struct Launch {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub quote_mint: Pubkey,
    /// Virtual reserves drive the curve price (constant product).
    pub v_quote: u128,
    pub v_token: u128,
    /// Quote actually collected on the curve, and tokens still unsold.
    pub real_quote: u64,
    pub real_token: u64,
    pub raise_target: u64,
    /// Quote-asset fee split. Sum <= FEE_CAP_BPS, each field within its ceiling.
    pub holder_bps: u16,
    pub creator_bps: u16,
    pub vault_bps: u16,
    pub burn_bps: u16,
    pub buyback_bps: u16,
    /// REX's share OF THE HOLDER BUCKET. Only ever lowered.
    pub rex_bps: u16,
    pub status: LaunchStatus,
    pub fair_open_ends: i64,
    pub fair_open_total: u64,
    pub fair_open_tokens: u64,
    pub fair_open_claimed_quote: u64,
    /// AMM reserves after graduation (liquidity is locked in the vaults forever).
    pub amm_quote: u64,
    pub amm_token: u64,
    /// Quote collected per bucket, all held in the one fee vault. `reward_pot` is the holders'
    /// share after REX's cut and is what an epoch distributes.
    pub reward_pot: u64,
    pub creator_pot: u64,
    pub vault_pot: u64,
    pub burn_pot: u64,
    pub buyback_pot: u64,
    pub rex_pot: u64,
    /// The revenue share, split off the moment it is earned rather than at payout. Nothing but the
    /// partner's own signature can move it: no sweep, no authority, no treasury call reaches it.
    pub partner_pot: u64,
    /// Cumulative quote notional swapped — the raw input to the off-chain verified-volume tier.
    pub volume_quote: u128,
    pub epoch_count: u32,
    pub holders: u32,
    pub bump: u8,
    /// ⛔ WHAT THE POOL HELD BEFORE THE RESERVES WERE RELEASED, so `migrate_confirm` can prove THIS
    /// migration funded it rather than that a pool happens to hold enough.
    ///
    /// Without these, the proof was `pool_vault.amount >= released`, which passes against a pool
    /// somebody else already filled — the migrator keeps the raise and points the proof at a
    /// pre-funded zero-LP pool. Snapshotting cannot be skipped by the caller either, because the
    /// pool address is pinned here too: `migrate_confirm` must prove the same pool that
    /// `migrate_release` measured, so choosing a different `amm_config` between the two steps no
    /// longer selects a different pool.
    ///
    /// Zero across all three means "no release in flight", which is the state every launch that has
    /// not migrated sits in — and is what a zero-filled resize produces for an account written
    /// before these fields existed.
    pub migrate_pool: Pubkey,
    pub migrate_vault_0: u64,
    pub migrate_vault_1: u64,
}

impl Launch {
    /// What a trader pays. REX's fee is carved OUT of `holder_bps`, so it is already inside this
    /// sum — it is not an additional fee and never widens the total.
    pub fn total_fee_bps(&self) -> u16 {
        self.holder_bps + self.creator_bps + self.vault_bps + self.burn_bps + self.buyback_bps
    }

    pub fn k(&self) -> u128 {
        self.v_quote.saturating_mul(self.v_token)
    }
    pub fn price_num_den(&self) -> (u128, u128) {
        match self.status {
            LaunchStatus::Graduated => (self.amm_quote as u128, self.amm_token as u128),
            _ => (self.v_quote, self.v_token),
        }
    }
}

/// A sealed Fair Open commitment. Escrowed until the bell, then converted at one uniform price.
#[account]
#[derive(InitSpace)]
pub struct Commit {
    pub launch: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

/// Per-holder position. `held_since` is the on-chain conviction clock: set when a position opens
/// from zero, left alone when adding, and reset to 0 the moment any tokens are sold.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub held_since: i64,
    pub bump: u8,
}

/// One reward epoch. The crank computes conviction-weighted shares off-chain and posts a merkle
/// root; holders claim against it. The pot is locked in the reward vault until claimed.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub launch: Pubkey,
    pub index: u32,
    pub root: [u8; 32],
    pub pot: u64,
    pub claimed: u64,
    pub ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub epoch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub bump: u8,
}


// ---------- Raydium CPMM, for graduation
//
// Our own AMM is not indexed by anyone: DexScreener, Birdeye and Jupiter read POOL PROGRAMS they
// already have adapters for, not arbitrary programs. So a graduated launch moves its reserves into
// a Raydium constant-product pool and burns the LP — the same shape pump.fun graduates into, and the
// reason a graduated coin gets charts, routing and aggregator volume for free.
//
// Both ids are real deployments; the devnet one is what raydium-cp-swap declares under its `devnet`
// feature, and it is NOT the only CPMM-looking program on devnet, so it is pinned rather than guessed.
pub const CPMM_MAINNET: &str = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
pub const CPMM_DEVNET: &str = "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb";
/// sha256("global:initialize")[..8] — Raydium is an Anchor program, so its selector is derivable.
pub const CPMM_INITIALIZE_IX: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];
