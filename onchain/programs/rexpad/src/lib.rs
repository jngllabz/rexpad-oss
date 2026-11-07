//! REXPAD — the $REX launchpad.
//!
//! Two mechanics live in this program:
//!   * **Fair Open** — commitments are escrowed in a vault for a sealed window. At the bell ONE
//!     aggregate buy hits the curve and every bidder (the creator included) is allocated pro-rata
//!     at the same uniform price. There is no ordering inside the window, so nothing to snipe.
//!   * **Conviction rewards** — the trade tax accrues into a reward vault. Each epoch a crank
//!     posts a merkle root of hold-time-weighted shares and holders claim against it. The
//!     conviction clock (`Position.held_since`) is kept on-chain and reset by any sell.
//!
//! Liquidity is never withdrawable: at graduation the raise plus the reserved LP tokens become
//! the AMM reserves inside the program's own vaults, which no instruction can drain.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub mod errors;
pub mod math;
pub mod state;

use errors::PadError;
use math::*;
use state::*;

// The program id is per-cluster, selected by the same `devnet` feature that picks the Raydium
// deployment below. Mainnet's config is authority-controlled by a key we hold; the ORIGINAL devnet
// config was initialised under a key nobody has any more, which left `migrate_config`, `distribute`
// and `raise_partner` permanently uncallable there. A separate devnet id lets devnet be re-genesised
// under a live authority without touching the mainnet deployment at all.
#[cfg(feature = "devnet")]
declare_id!("975nsaKdkJYg1Ui5qHWZXDJKKRnYZ5LntNzCBT9nqov5");
#[cfg(not(feature = "devnet"))]
declare_id!("2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E");

pub const CONFIG_SEED: &[u8] = b"config";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
pub const QUOTE_VAULT_SEED: &[u8] = b"quote_vault";
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";
pub const COMMIT_SEED: &[u8] = b"commit";
pub const POSITION_SEED: &[u8] = b"position";
pub const EPOCH_SEED: &[u8] = b"epoch";
pub const RECEIPT_SEED: &[u8] = b"receipt";

#[program]
pub mod rexpad {
    use super::*;

    /// `partner` / `partner_bps` are written in the SAME transaction that creates the config, so
    /// there is no window in which someone else could claim the revenue share first. Pass 0 bps only
    /// if there is genuinely no share; it can still be set once afterwards with `set_partner`.
    pub fn init_config(ctx: Context<InitConfig>, curve_fee_bps: u16, amm_fee_bps: u16, partner: Pubkey, partner_bps: u16) -> Result<()> {
        require!(curve_fee_bps <= 300 && amm_fee_bps <= 100, PadError::TaxTooHigh);
        require!(partner_bps <= PARTNER_MAX_BPS, PadError::PartnerShareTooHigh);
        require!(partner_bps == 0 || partner != Pubkey::default(), PadError::PartnerAccountMismatch);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.fee_wallet = ctx.accounts.fee_wallet.key();
        c.partner = partner;
        c.partner_bps = partner_bps;
        c.curve_fee_bps = curve_fee_bps;
        c.amm_fee_bps = amm_fee_bps;
        c.paused = false;
        c.bump = ctx.bumps.config;
        if partner_bps > 0 { emit!(PartnerSet { partner, partner_bps }); }
        Ok(())
    }

    /// Nominate the next authority. Takes effect only once that key calls `accept_authority`,
    /// so a mistyped pubkey costs nothing. Passing the default pubkey cancels a pending handover.
    pub fn propose_authority(ctx: Context<SetConfig>, new_authority: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.pending_authority = new_authority;
        emit!(AuthorityProposed { from: c.authority, to: new_authority });
        Ok(())
    }

    /// Claim an authority handover. Must be signed by the proposed key, which proves it exists and
    /// is controlled before anything irreversible happens.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.pending_authority != Pubkey::default(), PadError::NoPendingAuthority);
        require_keys_eq!(c.pending_authority, ctx.accounts.new_authority.key(), PadError::Unauthorized);
        let old = c.authority;
        c.authority = c.pending_authority;
        c.pending_authority = Pubkey::default();
        emit!(AuthorityChanged { from: old, to: c.authority });
        Ok(())
    }

    /// Set the revenue share on REXPAD's own cut. **This can be done exactly once and can never be
    /// undone.** There is deliberately no instruction anywhere in this program that lowers
    /// `partner_bps`, clears `partner`, or touches a partner balance — not for the authority, not
    /// for the partner, not for both of them together. Once a non-zero share is written it is a
    /// property of the protocol.
    ///
    /// The only thing that can still take it away is a program upgrade, so the deploy's upgrade
    /// authority has to be held accordingly, or the program made immutable.
    pub fn set_partner(ctx: Context<SetConfig>, partner: Pubkey, partner_bps: u16) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.partner_bps == 0, PadError::PartnerLocked);
        require!(partner_bps > 0 && partner_bps <= PARTNER_MAX_BPS, PadError::PartnerShareTooHigh);
        require!(partner != Pubkey::default(), PadError::PartnerAccountMismatch);
        c.partner = partner;
        c.partner_bps = partner_bps;
        emit!(PartnerSet { partner, partner_bps });
        Ok(())
    }

    /// RAISE the revenue share. Up only, and that direction is the entire safety argument.
    ///
    /// `set_partner` is one-shot by design, which is right for stopping anyone from quietly cutting
    /// a partner out — but it also means an honest mistake in the number is unfixable, and that is
    /// exactly what happened here: the share was written at 300 bps reading "10% of the development
    /// allocation" as 10% x 30%, when the agreed split is 10 points of the whole, 1000 bps.
    ///
    /// So rather than reopening `set_partner` and losing the guarantee, this adds a strictly weaker
    /// power: the authority may increase the share and can never decrease it. A partner's position
    /// can only improve. It grants the authority nothing it did not already have in practice, since
    /// the authority was always free to direct REX's own cut, and it cannot touch WHO receives the
    /// share — only `set_partner_wallet`, signed by the partner alone, can do that.
    pub fn raise_partner(ctx: Context<SetConfig>, partner_bps: u16) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.partner_bps > 0, PadError::PartnerAccountMismatch);
        require!(partner_bps > c.partner_bps, PadError::PartnerShareTooHigh);
        require!(partner_bps <= PARTNER_MAX_BPS, PadError::PartnerShareTooHigh);
        c.partner_bps = partner_bps;
        // ⛔ RAISING THE PARTNER SHARE INVALIDATES THE WATERFALL, SO SAY SO IN THE STATE.
        //
        // The five legs are validated against `10_000 - partner_bps` in `migrate_config` and
        // nowhere else, while `distribute` divides by the CURRENT partner share. Changing it here
        // without touching the legs leaves them summing to the old total over a smaller divisor:
        // at the 300 -> 1000 bps change this instruction exists to make, the five cuts come to
        // 107.78% of `rex_pot`. `reward_vault` is one account holding every bucket, so the excess
        // is taken from the holders' epoch money, the creator's cut and the partner's own
        // supposedly-segregated pot, leaving their counters untouched. Nothing errors: `rex_pot`
        // saturates at zero and the `Distributed` event reports the bucket cleared exactly. The
        // first symptom is an unrelated holder's `claim_reward` failing weeks later.
        //
        // Clearing the version makes `distribute`'s existing `require!(waterfall_version > 0)`
        // refuse until `migrate_config` has re-validated the legs against the new share. The
        // ordering was previously procedural — remember to do two things in the right order, with
        // a silent overpay as the only feedback for getting it wrong. An invariant that holds only
        // between two instructions that nothing couples is not an invariant.
        c.waterfall_version = 0;
        emit!(PartnerSet { partner: c.partner, partner_bps });
        Ok(())
    }

    /// Grow the config account so the waterfall fields exist, then write them.
    ///
    /// The config was allocated before those fields did, so until this runs the account is too
    /// small and ANY instruction that deserializes a `Config` would fail. That is why the account
    /// arrives here as raw bytes: this instruction cannot itself depend on the layout it is
    /// creating. It is idempotent — running it again only rewrites the legs.
    ///
    /// The legs must sum to exactly `10_000 - partner_bps`. Nothing is left over and nothing is
    /// double-counted; a split that did not add up would leave dust belonging to nobody, which is
    /// precisely the sort of thing that goes unnoticed until there is real money in it.
    /// Grow a Launch written before the migration-snapshot fields existed.
    ///
    /// ⛔ RAW BYTES, FOR THE SAME REASON `migrate_config` IS. This instruction exists to make the
    /// CURRENT layout fit, so it cannot assume that layout already fits: deserializing a typed
    /// `Account<Launch>` here is the one thing it must not do, because a 302-byte account against a
    /// 318-byte struct fails Borsh outright. The resize zero-fills, which is exactly the right
    /// "no release in flight" state for the three fields it adds.
    ///
    /// Permissionless on purpose. It can only ever grow an account and zero three fields that are
    /// already zero everywhere, so gating it on an authority would buy nothing and would leave a
    /// launch untradeable until that authority got round to it. Anyone may pay the rent.
    pub fn migrate_launch(ctx: Context<MigrateLaunch>) -> Result<()> {
        let info = ctx.accounts.launch.to_account_info();
        let need = 8 + Launch::INIT_SPACE;
        if info.data_len() >= need { return Ok(()); }   // already current; not an error
        let rent = Rent::get()?.minimum_balance(need);
        let short = rent.saturating_sub(info.lamports());
        if short > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                short,
            )?;
        }
        info.resize(need)?;
        Ok(())
    }

    pub fn migrate_config(ctx: Context<MigrateConfig>, legs: Waterfall) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        let need = 8 + Config::INIT_SPACE;
        if info.data_len() < need {
            let rent = Rent::get()?.minimum_balance(need);
            let short = rent.saturating_sub(info.lamports());
            if short > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        system_program::Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: info.clone(),
                        },
                    ),
                    short,
                )?;
            }
            info.resize(need)?;
        }
        // Read, mutate and write the bytes directly rather than building a typed `Account` — that
        // would borrow this local for the whole instruction lifetime, and the point of this function
        // is that it runs BEFORE the typed layout is guaranteed to fit.
        //
        // The resize zero-fills, so an old config deserializes with the new fields reading as
        // default: empty pubkeys and zero bps. That is the correct "not set yet" state, and
        // `waterfall_version` staying 0 is what `distribute` refuses on.
        let mut data = info.try_borrow_mut_data()?;
        let mut c = Config::try_deserialize(&mut &data[..])?;
        require!(c.authority == ctx.accounts.authority.key(), PadError::Unauthorized);
        let total = legs.dev2_bps as u32 + legs.buyback_bps as u32 + legs.usdc_bps as u32
            + legs.plays_bps as u32 + legs.vault_bps as u32;
        require!(total == (10_000u32 - c.partner_bps as u32), PadError::WaterfallMismatch);
        c.dev2 = legs.dev2; c.dev2_bps = legs.dev2_bps;
        c.buyback = legs.buyback; c.buyback_bps = legs.buyback_bps;
        c.usdc_reserve = legs.usdc_reserve; c.usdc_bps = legs.usdc_bps;
        c.plays = legs.plays; c.plays_bps = legs.plays_bps;
        c.vault = legs.vault; c.vault_bps = legs.vault_bps;
        c.waterfall_version = 1;
        c.try_serialize(&mut &mut data[..])?;
        drop(data);
        emit!(WaterfallSet { dev2_bps: legs.dev2_bps, buyback_bps: legs.buyback_bps,
            usdc_bps: legs.usdc_bps, plays_bps: legs.plays_bps, vault_bps: legs.vault_bps });
        Ok(())
    }

    /// Pay out REXPAD's bucket across the waterfall, in one transaction, to the five wallets the
    /// config names and to nothing else.
    ///
    /// This replaces sweeping the REX bucket to a single destination. The split happens here rather
    /// than in a script because a script's split is a promise and this one is arithmetic: each leg's
    /// account is checked against the config before a lamport moves, so the money cannot land
    /// anywhere else even if the authority wants it to.
    ///
    /// Shares are of the ORIGINAL REX income, and `rex_pot` is already net of the partner's share —
    /// so the denominator is what remains after it, not 10_000. Any remainder from integer division
    /// stays in the pot for the next run instead of being silently assigned to whichever leg is
    /// computed last.
    pub fn distribute(ctx: Context<Distribute>) -> Result<()> {
        let (pot, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            (l.rex_pot, l.mint, l.bump)
        };
        require!(pot > 0, PadError::EmptyBucket);
        let c = &ctx.accounts.config;
        require!(c.waterfall_version > 0, PadError::WaterfallUnset);
        let denom = (10_000u128).saturating_sub(c.partner_bps as u128);
        require!(denom > 0, PadError::WaterfallMismatch);
        // Belt to the braces above: the legs must sum to exactly the divisor they are cut against,
        // checked in the instruction that spends the money rather than only in the one that sets
        // the numbers. Any future path that changes `partner_bps` without re-migrating reverts
        // here instead of quietly paying out of the other buckets.
        let legs_total = c.dev2_bps as u128 + c.buyback_bps as u128 + c.usdc_bps as u128
            + c.plays_bps as u128 + c.vault_bps as u128;
        require!(legs_total == denom, PadError::WaterfallMismatch);

        let cut = |bps: u16| -> u64 { ((pot as u128) * bps as u128 / denom) as u64 };
        let legs: [(u64, &InterfaceAccount<TokenAccount>); 5] = [
            (cut(c.dev2_bps), &ctx.accounts.dev2_quote),
            (cut(c.buyback_bps), &ctx.accounts.buyback_quote),
            (cut(c.usdc_bps), &ctx.accounts.usdc_quote),
            (cut(c.plays_bps), &ctx.accounts.plays_quote),
            (cut(c.vault_bps), &ctx.accounts.vault_quote),
        ];
        let launch_ai = ctx.accounts.launch.to_account_info();
        let mut paid: u64 = 0;
        for (amount, dest) in legs.iter() {
            if *amount == 0 { continue; }
            transfer_out(&ctx.accounts.token_program, &ctx.accounts.reward_vault, dest,
                &launch_ai, &ctx.accounts.quote_mint, *amount, mint_key, bump)?;
            paid = paid.saturating_add(*amount);
        }
        // `saturating_sub` below turns an overpay into a silent zero and an event claiming the
        // bucket cleared exactly. Assert instead, so a regression reverts rather than raiding the
        // buckets sharing this vault.
        require!(paid <= pot, PadError::WaterfallMismatch);
        let l = &mut ctx.accounts.launch;
        l.rex_pot = pot.saturating_sub(paid);
        emit!(Distributed { launch: l.key(), total: paid, remainder: l.rex_pot });
        Ok(())
    }

    /// Point the share at a different wallet. Signed by the current partner alone: rotating your own
    /// receiving address is nobody else's decision, and it cannot change the agreed percentage or
    /// hand the share to anyone who is not already holding the partner key.
    pub fn set_partner_wallet(ctx: Context<SetPartnerWallet>, new_wallet: Pubkey) -> Result<()> {
        require!(new_wallet != Pubkey::default(), PadError::PartnerAccountMismatch);
        let c = &mut ctx.accounts.config;
        c.partner = new_wallet;
        emit!(PartnerSet { partner: new_wallet, partner_bps: c.partner_bps });
        Ok(())
    }

    /// Withdraw the accrued revenue share for one launch. Signed by the partner alone — it does not
    /// need the authority, a crank, or anyone else to have swept anything first, so the share cannot
    /// be withheld by simply never calling a payout.
    pub fn claim_partner(ctx: Context<ClaimPartner>) -> Result<()> {
        let (amount, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            (l.partner_pot, l.mint, l.bump)
        };
        require!(amount > 0, PadError::EmptyBucket);
        transfer_out(&ctx.accounts.token_program, &ctx.accounts.reward_vault, &ctx.accounts.partner_quote,
            &ctx.accounts.launch.to_account_info(), &ctx.accounts.quote_mint, amount, mint_key, bump)?;
        let l = &mut ctx.accounts.launch;
        l.partner_pot = 0;
        emit!(PartnerPaid { launch: l.key(), partner: ctx.accounts.partner.key(), amount });
        Ok(())
    }

    pub fn set_config(ctx: Context<SetConfig>, curve_fee_bps: u16, amm_fee_bps: u16, paused: bool) -> Result<()> {
        require!(curve_fee_bps <= 300 && amm_fee_bps <= 100, PadError::TaxTooHigh);
        let c = &mut ctx.accounts.config;
        c.curve_fee_bps = curve_fee_bps;
        c.amm_fee_bps = amm_fee_bps;
        c.paused = paused;
        Ok(())
    }

    /// Create a launch: fixed 1B supply minted into the program's vault, mint authority burned,
    /// curve sized so the raise is `raise_target` of the quote asset.
    pub fn create_launch(
        ctx: Context<CreateLaunch>,
        raise_target: u64,
        v_quote0: u64,
        holder_bps: u16,
        creator_bps: u16,
        vault_bps: u16,
        burn_bps: u16,
        buyback_bps: u16,
        fair_open_secs: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, PadError::Paused);
        // Each ceiling, then the 5% sum check — the launch reverts on anything above either.
        validate_fees(holder_bps, creator_bps, vault_bps, burn_bps, buyback_bps)?;
        require!(raise_target > 0 && v_quote0 > 0, PadError::BadAmount);
        require!((0..=3600).contains(&fair_open_secs), PadError::BadWindow);

        // Mint the entire supply to the curve vault, then permanently drop mint authority.
        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[ctx.bumps.launch]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.launch.to_account_info(),
                },
                &[seeds],
            ),
            TOTAL_SUPPLY,
        )?;
        token_interface::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                token_interface::SetAuthority {
                    current_authority: ctx.accounts.launch.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[seeds],
            ),
            token_interface::spl_token_2022::instruction::AuthorityType::MintTokens,
            None,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let l = &mut ctx.accounts.launch;
        l.creator = ctx.accounts.creator.key();
        l.mint = mint_key;
        l.quote_mint = ctx.accounts.quote_mint.key();
        l.v_quote = v_quote0 as u128;
        l.v_token = V_TOKEN0;
        l.real_quote = 0;
        l.real_token = CURVE_TOKENS;
        l.raise_target = raise_target;
        l.holder_bps = holder_bps;
        l.creator_bps = creator_bps;
        l.vault_bps = vault_bps;
        l.burn_bps = burn_bps;
        l.buyback_bps = buyback_bps;
        l.rex_bps = REX_TIER_LAUNCH_BPS;
        l.status = if fair_open_secs > 0 { LaunchStatus::FairOpen } else { LaunchStatus::Live };
        l.fair_open_ends = now + fair_open_secs;
        l.fair_open_total = 0;
        l.fair_open_tokens = 0;
        l.fair_open_claimed_quote = 0;
        l.amm_quote = 0;
        l.amm_token = 0;
        l.reward_pot = 0;
        l.creator_pot = 0;
        l.buyback_pot = 0;
        l.vault_pot = 0;
        l.burn_pot = 0;
        l.rex_pot = 0;
        l.volume_quote = 0;
        l.epoch_count = 0;
        l.holders = 0;
        l.bump = ctx.bumps.launch;
        emit!(LaunchCreated { launch: l.key(), mint: mint_key, creator: l.creator, quote_mint: l.quote_mint, fair_open_ends: l.fair_open_ends });
        Ok(())
    }

    /// Escrow a Fair Open commitment. Callable repeatedly until the bell; adds to your total.
    pub fn commit(ctx: Context<Commitment>, amount: u64) -> Result<()> {
        require!(amount > 0, PadError::BadAmount);
        let now = Clock::get()?.unix_timestamp;
        {
            let l = &ctx.accounts.launch;
            require!(l.status == LaunchStatus::FairOpen, PadError::WindowClosed);
            require!(now < l.fair_open_ends, PadError::WindowClosed);
            // ⛔ THE CAP IS ON ANY ONE BIDDER NOW, NOT ON THE CREATOR'S KEY. Keyed on identity it
            // was decoration: `Commit` PDAs are seeded per bidder, so a creator committing from a
            // second keypair was an ordinary bidder with its own uncapped PDA, and there is no
            // sybil resistance to add on chain — the auditors were right that no identity-based
            // fix exists. What does exist is a constraint that does not care who you are. Applied
            // to every bidder it is the same ceiling, it cannot be stepped around with a fresh
            // wallet, and it makes the claim on the launch page true instead of aspirational.
            //
            // ⚠ This is a behaviour change, not just a hardening: a single large bidder who could
            // previously take half a fair open is now held to a fifth of it, same as the dev. That
            // reads as consistent with a sealed-bid open whose whole pitch is that nobody gets the
            // first bite, but it is a product decision and it is deliberate.
            {
                let already = if ctx.accounts.commitment.launch == Pubkey::default() { 0 } else { ctx.accounts.commitment.amount };
                let cap = (l.raise_target as u128 * DEV_COMMIT_MAX_BPS as u128 / BPS) as u64;
                require!(already.saturating_add(amount) <= cap, PadError::DevCommitTooLarge);
            }
        }
        transfer_in(
            &ctx.accounts.token_program,
            &ctx.accounts.bidder_quote,
            &ctx.accounts.quote_vault,
            &ctx.accounts.bidder.to_account_info(),
            &ctx.accounts.quote_mint,
            amount,
        )?;
        let c = &mut ctx.accounts.commitment;
        if c.launch == Pubkey::default() {
            c.launch = ctx.accounts.launch.key();
            c.bidder = ctx.accounts.bidder.key();
            c.bump = ctx.bumps.commitment;
        }
        c.amount = c.amount.checked_add(amount).ok_or(PadError::MathOverflow)?;
        let l = &mut ctx.accounts.launch;
        l.fair_open_total = l.fair_open_total.checked_add(amount).ok_or(PadError::MathOverflow)?;
        emit!(Committed { launch: l.key(), bidder: c.bidder, amount, total: l.fair_open_total });
        Ok(())
    }

    /// Pull a commitment back out before the bell.
    pub fn withdraw_commit(ctx: Context<WithdrawCommit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (amount, launch_key, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            require!(l.status == LaunchStatus::FairOpen, PadError::WindowClosed);
            require!(now < l.fair_open_ends, PadError::WindowClosed);
            (ctx.accounts.commitment.amount, l.key(), l.mint, l.bump)
        };
        require!(amount > 0, PadError::NothingToClaim);
        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.quote_vault,
            &ctx.accounts.bidder_quote,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.quote_mint,
            amount,
            mint_key,
            bump,
        )?;
        let l = &mut ctx.accounts.launch;
        l.fair_open_total = l.fair_open_total.saturating_sub(amount);
        ctx.accounts.commitment.amount = 0;
        emit!(Committed { launch: launch_key, bidder: ctx.accounts.bidder.key(), amount: 0, total: l.fair_open_total });
        Ok(())
    }

    /// Ring the bell. Permissionless once the window has passed: performs ONE aggregate buy on
    /// the curve for everything committed, which fixes a single clearing price for everybody.
    pub fn settle_fair_open(ctx: Context<SettleFairOpen>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let partner_bps = ctx.accounts.config.partner_bps;
        let l = &mut ctx.accounts.launch;
        require!(l.status == LaunchStatus::FairOpen, PadError::WindowClosed);
        require!(now >= l.fair_open_ends, PadError::WindowOpen);

        if l.fair_open_total == 0 {
            l.status = LaunchStatus::Live;
            emit!(FairOpenSettled { launch: l.key(), total: 0, tokens: 0, graduated: false });
            return Ok(());
        }
        let r = quote_buy(l, l.fair_open_total, partner_bps)?;
        let graduated = apply_buy(l, &r)?;
        l.fair_open_tokens = r.tokens_out;
        // Any refund from over-filling the curve stays in the vault and is paid out pro-rata on claim.
        l.fair_open_claimed_quote = r.refund;
        if l.status == LaunchStatus::FairOpen {
            l.status = LaunchStatus::Live;
        }
        let key = l.key();
        let mint_key = l.mint;
        let bump = l.bump;
        move_fees_to_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.quote_vault,
            &ctx.accounts.reward_vault,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.quote_mint,
            r.fees.total(),
            mint_key,
            bump,
        )?;
        emit!(FairOpenSettled { launch: key, total: ctx.accounts.launch.fair_open_total, tokens: ctx.accounts.launch.fair_open_tokens, graduated });
        Ok(())
    }

    /// Claim your pro-rata allocation from a settled Fair Open.
    pub fn claim_fair_open(ctx: Context<ClaimFairOpen>) -> Result<()> {
        let (tokens, refund, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            let c = &ctx.accounts.commitment;
            require!(l.status != LaunchStatus::FairOpen, PadError::WindowOpen);
            require!(!c.claimed && c.amount > 0, PadError::NothingToClaim);
            let share_num = c.amount as u128;
            let share_den = l.fair_open_total as u128;
            require!(share_den > 0, PadError::NothingToClaim);
            let tokens = u64::try_from(l.fair_open_tokens as u128 * share_num / share_den)
                .map_err(|_| PadError::MathOverflow)?;
            let refund = u64::try_from(l.fair_open_claimed_quote as u128 * share_num / share_den)
                .map_err(|_| PadError::MathOverflow)?;
            (tokens, refund, l.mint, l.bump)
        };
        // ⛔ THE REFUND IS A SEPARATE LEG AND MUST NOT HANG ON THE TOKEN LEG. This gated the whole
        // instruction on `tokens > 0`, so a bidder whose pro-rata allocation floored to zero could
        // never claim — and `claimed` is only set here, so their quote refund was unreachable
        // forever. Reachability is poor (it needs a commitment small enough to floor a ~10^14 unit
        // allocation to nothing), but the money being stuck is permanent when it happens, and
        // "unlikely" is not the same as "safe".
        require!(tokens > 0 || refund > 0, PadError::NothingToClaim);
        if tokens > 0 {
            transfer_out(
                &ctx.accounts.token_program,
                &ctx.accounts.token_vault,
                &ctx.accounts.bidder_token,
                &ctx.accounts.launch.to_account_info(),
                &ctx.accounts.mint,
                tokens,
                mint_key,
                bump,
            )?;
        }
        if refund > 0 {
            transfer_out(
                &ctx.accounts.token_program,
                &ctx.accounts.quote_vault,
                &ctx.accounts.bidder_quote,
                &ctx.accounts.launch.to_account_info(),
                &ctx.accounts.quote_mint,
                refund,
                mint_key,
                bump,
            )?;
        }
        ctx.accounts.commitment.claimed = true;
        let now = Clock::get()?.unix_timestamp;
        // ⛔ COUNT A HOLDER ONCE. `buy` increments only on a genuinely new position, guarded by
        // `was_empty`; this incremented unconditionally, so a bidder who bought on the curve before
        // claiming their allocation was counted twice and `holders` drifted upward permanently —
        // it is a launch-lifetime counter with no recount anywhere. Same guard, same meaning.
        let was_empty = ctx.accounts.position.amount == 0;
        open_position(&mut ctx.accounts.position, &ctx.accounts.launch.key(), &ctx.accounts.bidder.key(), ctx.bumps.position, tokens, now)?;
        let l = &mut ctx.accounts.launch;
        if was_empty { l.holders = l.holders.saturating_add(1); }
        Ok(())
    }

    /// Buy on the curve (or the AMM after graduation).
    pub fn buy(ctx: Context<Trade>, quote_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, PadError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let partner_bps = ctx.accounts.config.partner_bps;
        let (r, mint_key, bump, graduated) = {
            let l = &mut ctx.accounts.launch;
            require!(l.status != LaunchStatus::FairOpen, PadError::NotLive);
            require!(l.status != LaunchStatus::Migrated, PadError::AlreadyMigrated);
            let r = quote_buy(l, quote_in, partner_bps)?;
            require!(r.tokens_out >= min_tokens_out, PadError::Slippage);
            let graduated = apply_buy(l, &r)?;
            (r, l.mint, l.bump, graduated)
        };
        // Charge only what the curve actually took; the refund never leaves the buyer.
        transfer_in(
            &ctx.accounts.token_program,
            &ctx.accounts.user_quote,
            &ctx.accounts.quote_vault,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.quote_mint,
            r.gross,
        )?;
        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.token_vault,
            &ctx.accounts.user_token,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.mint,
            r.tokens_out,
            mint_key,
            bump,
        )?;
        move_fees_to_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.quote_vault,
            &ctx.accounts.reward_vault,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.quote_mint,
            r.fees.total(),
            mint_key,
            bump,
        )?;
        let p = &mut ctx.accounts.position;
        let was_empty = p.amount == 0;
        open_position(p, &ctx.accounts.launch.key(), &ctx.accounts.user.key(), ctx.bumps.position, r.tokens_out, now)?;
        if was_empty {
            let l = &mut ctx.accounts.launch;
            l.holders = l.holders.saturating_add(1);
        }
        emit!(Traded { launch: ctx.accounts.launch.key(), user: ctx.accounts.user.key(), is_buy: true, quote: r.gross, tokens: r.tokens_out, graduated });
        Ok(())
    }

    /// Sell back to the curve/AMM. **Any sell resets the conviction clock to zero.**
    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_quote_out: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, PadError::Paused);
        require!(ctx.accounts.position.amount >= tokens_in, PadError::InsufficientPosition);
        let partner_bps = ctx.accounts.config.partner_bps;
        let (r, mint_key, bump) = {
            let l = &mut ctx.accounts.launch;
            require!(l.status != LaunchStatus::FairOpen, PadError::NotLive);
            require!(l.status != LaunchStatus::Migrated, PadError::AlreadyMigrated);
            let r = quote_sell(l, tokens_in, partner_bps)?;
            require!(r.quote_out >= min_quote_out, PadError::Slippage);
            apply_sell(l, tokens_in, &r)?;
            (r, l.mint, l.bump)
        };
        transfer_in(
            &ctx.accounts.token_program,
            &ctx.accounts.user_token,
            &ctx.accounts.token_vault,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.mint,
            tokens_in,
        )?;
        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.quote_vault,
            &ctx.accounts.user_quote,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.quote_mint,
            r.quote_out,
            mint_key,
            bump,
        )?;
        move_fees_to_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.quote_vault,
            &ctx.accounts.reward_vault,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.quote_mint,
            r.fees.total(),
            mint_key,
            bump,
        )?;
        let p = &mut ctx.accounts.position;
        p.amount = p.amount.checked_sub(tokens_in).ok_or(PadError::MathOverflow)?;
        p.held_since = 0; // conviction reset — this is the whole point
        if p.amount == 0 {
            let l = &mut ctx.accounts.launch;
            l.holders = l.holders.saturating_sub(1);
        }
        emit!(Traded { launch: ctx.accounts.launch.key(), user: ctx.accounts.user.key(), is_buy: false, quote: r.quote_out, tokens: tokens_in, graduated: false });
        Ok(())
    }

    /// Crank: close out the accrued pot into a claimable epoch with a merkle root of
    /// conviction-weighted shares. The pot is already sitting in the reward vault.
    pub fn post_epoch(ctx: Context<PostEpoch>, root: [u8; 32], pot: u64) -> Result<()> {
        let l = &mut ctx.accounts.launch;
        require!(pot > 0 && pot <= l.reward_pot, PadError::PotTooLarge);
        let e = &mut ctx.accounts.epoch;
        e.launch = l.key();
        e.index = l.epoch_count;
        e.root = root;
        e.pot = pot;
        e.claimed = 0;
        e.ts = Clock::get()?.unix_timestamp;
        e.bump = ctx.bumps.epoch;
        l.reward_pot = l.reward_pot.saturating_sub(pot);
        l.epoch_count = l.epoch_count.saturating_add(1);
        emit!(EpochPosted { launch: e.launch, index: e.index, pot });
        Ok(())
    }

    /// The creator withdraws their bucket. REX never touches it.
    pub fn claim_creator(ctx: Context<ClaimBucket>) -> Result<()> {
        let (amount, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            require!(ctx.accounts.beneficiary.key() == l.creator, PadError::Unauthorized);
            (l.creator_pot, l.mint, l.bump)
        };
        require!(amount > 0, PadError::EmptyBucket);
        transfer_out(&ctx.accounts.token_program, &ctx.accounts.reward_vault, &ctx.accounts.beneficiary_quote,
            &ctx.accounts.launch.to_account_info(), &ctx.accounts.quote_mint, amount, mint_key, bump)?;
        ctx.accounts.launch.creator_pot = 0;
        emit!(BucketPaid { launch: ctx.accounts.launch.key(), bucket: 1, amount });
        Ok(())
    }

    /// Sweep the vault / burn / REX buckets out to the addresses that do their jobs.
    /// `bucket`: 2 = vault (70% LP, 30% quote bid), 3 = burn (buys the token and burns it),
    /// 4 = REX (20% burn, 60% buyback, 20% protocol LP). None of these can be redeemed by a user.

    /// Step 1 of 2. Hand a graduated launch's reserves to whoever is building the pool.
    ///
    /// This looks like it gives the reserves away, and on its own it would. It is never on its own:
    /// `migrate_confirm` must succeed later in the SAME transaction or everything here is reverted,
    /// including these transfers. Atomicity is doing the work a signature cannot — Raydium bills its
    /// pool-creation fee with a System transfer from the pool creator, and the System program will
    /// only move lamports out of accounts it owns, so a PDA of ours can never be that creator.
    pub fn migrate_release(ctx: Context<MigrateRelease>) -> Result<()> {
        let (quote_amt, token_amt, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            require!(l.status == LaunchStatus::Graduated, PadError::NotGraduated);
            require!(l.amm_quote > 0 && l.amm_token > 0, PadError::NothingToMigrate);
            (l.amm_quote, l.amm_token, l.mint, l.bump)
        };
        let launch_ai = ctx.accounts.launch.to_account_info();
        transfer_out(&ctx.accounts.token_program, &ctx.accounts.token_vault, &ctx.accounts.migrator_token,
            &launch_ai, &ctx.accounts.mint, token_amt, mint_key, bump)?;
        transfer_out(&ctx.accounts.quote_token_program, &ctx.accounts.quote_vault, &ctx.accounts.migrator_quote,
            &launch_ai, &ctx.accounts.quote_mint, quote_amt, mint_key, bump)?;
        // ⛔ PIN THE POOL AND RECORD WHAT IT HELD, so confirm can prove THIS release filled it.
        //
        // The proof used to be `pool_vault.amount >= released`, which is satisfied by a pool
        // somebody else already funded: the migrator keeps the raise and points the proof at a
        // pre-funded zero-LP pool for the pair. Measuring here and requiring the exact delta there
        // closes that, and recording the pool address closes the other half — the caller chooses
        // `amm_config`, so without this they could measure one pool and prove another.
        //
        // Deliberately the DELTA and not an equality: a stranger donating to the vault between the
        // two steps raises the balance, and `after - before >= released` still holds, whereas a bare
        // `==` would let anyone wedge a migration permanently with dust.
        let cpmm = ctx.accounts.cp_swap_program.key();
        let token_mint = ctx.accounts.mint.key();
        let quote_mint_k = ctx.accounts.quote_mint.key();
        let (m0, m1) = if token_mint < quote_mint_k { (token_mint, quote_mint_k) } else { (quote_mint_k, token_mint) };
        let (pool, _) = Pubkey::find_program_address(
            &[b"pool", ctx.accounts.amm_config.key().as_ref(), m0.as_ref(), m1.as_ref()], &cpmm);
        let (expect_v0, _) = Pubkey::find_program_address(&[b"pool_vault", pool.as_ref(), m0.as_ref()], &cpmm);
        let (expect_v1, _) = Pubkey::find_program_address(&[b"pool_vault", pool.as_ref(), m1.as_ref()], &cpmm);
        require_keys_eq!(ctx.accounts.pool_vault_0.key(), expect_v0, PadError::MigrationNotProven);
        require_keys_eq!(ctx.accounts.pool_vault_1.key(), expect_v1, PadError::MigrationNotProven);
        // A vault that does not exist yet holds nothing, which is the common case: the migrator
        // usually creates the pool with the funds it was just handed.
        let bal = |ai: &UncheckedAccount| -> u64 {
            let d = ai.data.borrow();
            if d.len() < 72 { return 0; }
            u64::from_le_bytes(d[64..72].try_into().unwrap_or([0u8; 8]))
        };
        let l = &mut ctx.accounts.launch;
        l.migrate_pool = pool;
        l.migrate_vault_0 = bal(&ctx.accounts.pool_vault_0);
        l.migrate_vault_1 = bal(&ctx.accounts.pool_vault_1);
        // amm_quote / amm_token are deliberately NOT cleared: they are what confirm checks against.
        l.status = LaunchStatus::Migrating;
        Ok(())
    }

    /// Step 2 of 2. Prove the pool exists, holds the reserves, and that nobody holds any LP.
    ///
    /// Every account is re-derived here rather than trusted. The pool must sit at Raydium's own
    /// seeds for this exact pair, its vaults must sit at Raydium's seeds for that pool, and they
    /// must actually hold what was released. The LP check is the strict one: Raydium only ever MINTS
    /// `liquidity - 100`, so once the migrator burns what they were given the supply is exactly
    /// zero. A non-zero supply means somebody still holds a claim on the liquidity, and this fails.
    pub fn migrate_confirm(ctx: Context<MigrateConfirm>) -> Result<()> {
        let l = &ctx.accounts.launch;
        require!(l.status == LaunchStatus::Migrating, PadError::NotMigrating);
        let (quote_amt, token_amt) = (l.amm_quote, l.amm_token);

        let cpmm = ctx.accounts.cp_swap_program.key();
        let token_mint = ctx.accounts.mint.key();
        let quote_mint = ctx.accounts.quote_mint.key();
        let (m0, m1) = if token_mint < quote_mint { (token_mint, quote_mint) } else { (quote_mint, token_mint) };

        // ⛔ THE CALLER PICKS `amm_config`, AND IT IS ONLY A DERIVATION SEED — so without this it
        // selects WHICH pool address counts as "the" pool for this pair. Requiring it to be a real
        // Raydium config account narrows that choice from any pubkey at all to the handful Raydium
        // has actually created, which together with the zero-LP requirement below is what makes
        // finding REX-02 hard rather than easy.
        //
        // ⚠ THIS IS A NARROWING, NOT THE FULL FIX. The reserve checks further down are `>=` against
        // absolute balances, so they prove a pool exists holding at least the released amounts —
        // not that THIS migration funded it. Proving that needs the vault balances snapshotted
        // before `migrate_release` and an exact-delta check here, which means two new fields on
        // `Launch`. rexpad is deployed and live, so that is a migration decision rather than a
        // patch, and it is left for the owner. Note the delta form is also the grief-free one:
        // `after - before >= released` still passes if a stranger donates to the vault, whereas a
        // bare equality check would let anyone wedge a migration permanently with dust.
        require_keys_eq!(*ctx.accounts.amm_config.owner, cpmm, PadError::MigrationNotProven);

        let pool = ctx.accounts.pool_state.key();
        let (expect_pool, _) = Pubkey::find_program_address(
            &[b"pool", ctx.accounts.amm_config.key().as_ref(), m0.as_ref(), m1.as_ref()], &cpmm);
        require_keys_eq!(pool, expect_pool, PadError::MigrationNotProven);
        // An uninitialised pool is still at the right address, so the owner check is what proves
        // Raydium actually created it rather than someone pre-funding an empty account there.
        require_keys_eq!(*ctx.accounts.pool_state.owner, cpmm, PadError::MigrationNotProven);

        let (expect_lp, _) = Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &cpmm);
        require_keys_eq!(ctx.accounts.lp_mint.key(), expect_lp, PadError::MigrationNotProven);
        require!(ctx.accounts.lp_mint.supply == 0, PadError::LpNotBurned);

        let (expect_v0, _) = Pubkey::find_program_address(&[b"pool_vault", pool.as_ref(), m0.as_ref()], &cpmm);
        let (expect_v1, _) = Pubkey::find_program_address(&[b"pool_vault", pool.as_ref(), m1.as_ref()], &cpmm);
        require_keys_eq!(ctx.accounts.pool_vault_0.key(), expect_v0, PadError::MigrationNotProven);
        require_keys_eq!(ctx.accounts.pool_vault_1.key(), expect_v1, PadError::MigrationNotProven);

        // ⛔ THE SAME POOL `migrate_release` MEASURED, and the exact delta against what it held.
        //
        // `>=` against an absolute balance proved a pool holds at least the released amounts — not
        // that this migration put them there. A migrator could keep the raise and point the proof
        // at a pool somebody else had already funded, provided its LP supply was zero. Comparing
        // against the snapshot closes it; pinning the pool closes the other half, since the caller
        // picks `amm_config` and could otherwise measure one pool and prove another.
        //
        // Still `>=` on the DELTA rather than `==` on the balance: a stranger donating to the vault
        // between the two steps only raises it, and the delta still covers the release, whereas a
        // bare equality would let anyone wedge a migration for ever with dust.
        require_keys_eq!(pool, ctx.accounts.launch.migrate_pool, PadError::MigrationNotProven);
        let (need_0, need_1) = if token_mint < quote_mint { (token_amt, quote_amt) } else { (quote_amt, token_amt) };
        let grew_0 = ctx.accounts.pool_vault_0.amount.saturating_sub(ctx.accounts.launch.migrate_vault_0);
        let grew_1 = ctx.accounts.pool_vault_1.amount.saturating_sub(ctx.accounts.launch.migrate_vault_1);
        require!(grew_0 >= need_0, PadError::MigrationNotProven);
        require!(grew_1 >= need_1, PadError::MigrationNotProven);

        let l = &mut ctx.accounts.launch;
        l.status = LaunchStatus::Migrated;
        l.amm_quote = 0;
        l.amm_token = 0;
        // Back to "no release in flight", so a finished migration leaves nothing behind to reuse.
        l.migrate_pool = Pubkey::default();
        l.migrate_vault_0 = 0;
        l.migrate_vault_1 = 0;
        emit!(Migrated { launch: l.key(), pool, quote: quote_amt, tokens: token_amt });
        Ok(())
    }

    pub fn sweep_bucket(ctx: Context<SweepBucket>, bucket: u8) -> Result<()> {
        let (amount, mint_key, bump) = {
            let l = &ctx.accounts.launch;
            let amount = match bucket { 2 => l.vault_pot, 3 => l.burn_pot, 4 => l.rex_pot, 5 => l.buyback_pot, _ => 0 };
            (amount, l.mint, l.bump)
        };
        require!(amount > 0, PadError::EmptyBucket);
        // `rex_pot` is already net of the revenue share: it was split off at accrual into
        // `partner_pot`, which this instruction cannot reach. A sweep moves REXPAD's money only.
        transfer_out(&ctx.accounts.token_program, &ctx.accounts.reward_vault, &ctx.accounts.destination,
            &ctx.accounts.launch.to_account_info(), &ctx.accounts.quote_mint, amount, mint_key, bump)?;
        let l = &mut ctx.accounts.launch;
        match bucket { 2 => l.vault_pot = 0, 3 => l.burn_pot = 0, 4 => l.rex_pot = 0, 5 => l.buyback_pot = 0, _ => {} }
        emit!(BucketPaid { launch: l.key(), bucket, amount });
        Ok(())
    }

    /// Step a launch down the REX fee schedule: 0.50% → 0.45% → … → 0.20%. Whatever REX gives up
    /// goes straight back to the holder allocation, since REX's fee is carved out of it. Which
    /// milestone has been reached is computed off-chain; on chain we enforce only that the fee moves
    /// in 0.05% steps, never rises, and never goes below the 0.20% floor.
    pub fn set_rex_tier(ctx: Context<SetRexTier>, rex_bps: u16) -> Result<()> {
        let l = &mut ctx.accounts.launch;
        require!(rex_bps <= l.rex_bps, PadError::TierCannotRise);
        require!(rex_bps >= REX_TIER_FLOOR_BPS, PadError::TierCannotRise);
        require!((l.rex_bps - rex_bps) % REX_TIER_STEP_BPS == 0, PadError::FeeStep);
        l.rex_bps = rex_bps;
        emit!(TierChanged { launch: l.key(), rex_bps });
        Ok(())
    }

    /// Claim your share of an epoch with a merkle proof. One receipt per (epoch, wallet).
    pub fn claim_reward(ctx: Context<ClaimReward>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        require!(amount > 0, PadError::BadAmount);
        let (root, mint_key, bump) = {
            let e = &ctx.accounts.epoch;
            (e.root, ctx.accounts.launch.mint, ctx.accounts.launch.bump)
        };
        let leaf = solana_sha256_hasher::hashv(&[
            ctx.accounts.claimant.key().as_ref(),
            &amount.to_le_bytes(),
            ctx.accounts.epoch.key().as_ref(),
        ])
        .to_bytes();
        require!(verify_proof(&proof, root, leaf), PadError::BadProof);
        {
            let e = &mut ctx.accounts.epoch;
            e.claimed = e.claimed.checked_add(amount).ok_or(PadError::MathOverflow)?;
            require!(e.claimed <= e.pot, PadError::PotTooLarge);
        }
        transfer_out(
            &ctx.accounts.token_program,
            &ctx.accounts.reward_vault,
            &ctx.accounts.claimant_quote,
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.quote_mint,
            amount,
            mint_key,
            bump,
        )?;
        let r = &mut ctx.accounts.receipt;
        r.epoch = ctx.accounts.epoch.key();
        r.owner = ctx.accounts.claimant.key();
        r.amount = amount;
        r.bump = ctx.bumps.receipt;
        emit!(RewardClaimed { launch: ctx.accounts.launch.key(), epoch: r.epoch, owner: r.owner, amount });
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

fn open_position(p: &mut Account<Position>, launch: &Pubkey, owner: &Pubkey, bump: u8, add: u64, now: i64) -> Result<()> {
    if p.launch == Pubkey::default() {
        p.launch = *launch;
        p.owner = *owner;
        p.bump = bump;
    }
    // Opening from zero starts the clock; adding to a live position never restarts it.
    if p.amount == 0 || p.held_since == 0 {
        p.held_since = now;
    }
    p.amount = p.amount.checked_add(add).ok_or(PadError::MathOverflow)?;
    Ok(())
}

fn transfer_in<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
        ),
        amount,
        mint.decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_out<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    launch: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    amount: u64,
    mint_key: Pubkey,
    bump: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[LAUNCH_SEED, mint_key.as_ref(), &[bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: launch.clone(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn move_fees_to_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    quote_vault: &InterfaceAccount<'info, TokenAccount>,
    reward_vault: &InterfaceAccount<'info, TokenAccount>,
    launch: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    amount: u64,
    mint_key: Pubkey,
    bump: u8,
) -> Result<()> {
    transfer_out(token_program, quote_vault, reward_vault, launch, mint, amount, mint_key, bump)
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: destination wallet for platform fees, stored only
    pub fee_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PadError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    // Every leg is pinned to the wallet the config names. The authority signs to say WHEN the money
    // moves and has no say in WHERE it lands.
    #[account(mut, token::mint = quote_mint, token::authority = config.dev2)]
    pub dev2_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = config.buyback)]
    pub buyback_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = config.usdc_reserve)]
    pub usdc_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = config.plays)]
    pub plays_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = config.vault)]
    pub vault_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct MigrateLaunch<'info> {
    /// CHECK: deliberately raw — see `migrate_launch`. The seeds cannot be used here, because they
    /// derive from `launch.mint` and reading that means deserializing the very layout this grows.
    /// `owner = crate::ID` is the check that matters instead: it must be an account this program
    /// owns, so nobody can point this at a stranger's account and have the payer fund its rent.
    #[account(mut, owner = crate::ID)]
    pub launch: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    /// CHECK: deliberately raw. This instruction grows the account to fit the CURRENT layout, so it
    /// cannot assume that layout already fits — deserializing here is the one thing it must not do.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// The five legs, passed as one argument so a caller cannot set four and forget the fifth.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Waterfall {
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
}

#[event]
pub struct WaterfallSet { pub dev2_bps: u16, pub buyback_bps: u16, pub usdc_bps: u16, pub plays_bps: u16, pub vault_bps: u16 }
#[event]
pub struct Distributed { pub launch: Pubkey, pub total: u64, pub remainder: u64 }

#[derive(Accounts)]
pub struct ClaimPartner<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = partner)]
    pub partner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.partner @ PadError::Unauthorized)]
    pub partner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetPartnerWallet<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = config.partner @ PadError::Unauthorized)]
    pub partner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PadError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = creator, space = 8 + Launch::INIT_SPACE, seeds = [LAUNCH_SEED, mint.key().as_ref()], bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init, payer = creator, mint::decimals = 6, mint::authority = launch, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = creator, token::mint = mint, token::authority = launch, token::token_program = token_program,
              seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = creator, token::mint = quote_mint, token::authority = launch, token::token_program = token_program,
              seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = creator, token::mint = quote_mint, token::authority = launch, token::token_program = token_program,
              seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Commitment<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init_if_needed, payer = bidder, space = 8 + Commit::INIT_SPACE,
              seeds = [COMMIT_SEED, launch.key().as_ref(), bidder.key().as_ref()], bump)]
    pub commitment: Box<Account<'info, Commit>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = bidder)]
    pub bidder_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCommit<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, close = bidder, seeds = [COMMIT_SEED, launch.key().as_ref(), bidder.key().as_ref()], bump = commitment.bump,
              has_one = bidder @ PadError::Unauthorized)]
    pub commitment: Box<Account<'info, Commit>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = bidder)]
    pub bidder_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SettleFairOpen<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub cranker: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimFairOpen<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [COMMIT_SEED, launch.key().as_ref(), bidder.key().as_ref()], bump = commitment.bump,
              has_one = bidder @ PadError::Unauthorized)]
    pub commitment: Box<Account<'info, Commit>>,
    #[account(init_if_needed, payer = bidder, space = 8 + Position::INIT_SPACE,
              seeds = [POSITION_SEED, launch.key().as_ref(), bidder.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(address = launch.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = bidder, associated_token::mint = mint, associated_token::authority = bidder, associated_token::token_program = token_program)]
    pub bidder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = bidder)]
    pub bidder_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
              seeds = [POSITION_SEED, launch.key().as_ref(), user.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(address = launch.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint, associated_token::authority = user, associated_token::token_program = token_program)]
    pub user_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = user)]
    pub user_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimBucket<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = quote_mint, token::authority = beneficiary)]
    pub beneficiary_quote: InterfaceAccount<'info, TokenAccount>,
    pub beneficiary: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SweepBucket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PadError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    /// Where a swept bucket is allowed to land, and the answer is: one address, named on chain.
    ///
    /// This used to be any token account the authority cared to name, which meant `fee_wallet` was a
    /// statement of intent rather than a rule — the config recorded where REX's income was *meant*
    /// to go while the program would happily send it somewhere else. Anyone auditing the config
    /// would have read a guarantee that was not there.
    ///
    /// Now the token program itself refuses a sweep to anything `fee_wallet` does not own. The
    /// authority keeps the power to decide WHEN money moves and still cannot decide WHERE.
    ///
    /// The cost of that is real and deliberate: there is no instruction anywhere that changes
    /// `fee_wallet`. Lose that key and every future sweep has nowhere legal to go. A lock that the
    /// authority could re-point on demand would not be a lock at all, so this is the trade.
    #[account(mut, token::mint = quote_mint, token::authority = config.fee_wallet)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetRexTier<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PadError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PostEpoch<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ PadError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init, payer = authority, space = 8 + Epoch::INIT_SPACE,
              seeds = [EPOCH_SEED, launch.key().as_ref(), &launch.epoch_count.to_le_bytes()], bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [EPOCH_SEED, launch.key().as_ref(), &epoch.index.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = claimant, space = 8 + ClaimReceipt::INIT_SPACE,
              seeds = [RECEIPT_SEED, epoch.key().as_ref(), claimant.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [REWARD_VAULT_SEED, launch.key().as_ref()], bump)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = claimant)]
    pub claimant_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub claimant: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct LaunchCreated { pub launch: Pubkey, pub mint: Pubkey, pub creator: Pubkey, pub quote_mint: Pubkey, pub fair_open_ends: i64 }
#[event]
pub struct Committed { pub launch: Pubkey, pub bidder: Pubkey, pub amount: u64, pub total: u64 }
#[event]
pub struct FairOpenSettled { pub launch: Pubkey, pub total: u64, pub tokens: u64, pub graduated: bool }
#[event]
pub struct Traded { pub launch: Pubkey, pub user: Pubkey, pub is_buy: bool, pub quote: u64, pub tokens: u64, pub graduated: bool }
#[event]
pub struct BucketPaid { pub launch: Pubkey, pub bucket: u8, pub amount: u64 }
#[event]
pub struct TierChanged { pub launch: Pubkey, pub rex_bps: u16 }
#[event]
pub struct AuthorityProposed { pub from: Pubkey, pub to: Pubkey }
#[event]
pub struct PartnerSet { pub partner: Pubkey, pub partner_bps: u16 }
#[event]
pub struct PartnerPaid { pub launch: Pubkey, pub partner: Pubkey, pub amount: u64 }
#[event]
pub struct AuthorityChanged { pub from: Pubkey, pub to: Pubkey }
#[event]
pub struct EpochPosted { pub launch: Pubkey, pub index: u32, pub pot: u64 }
#[event]
pub struct RewardClaimed { pub launch: Pubkey, pub epoch: Pubkey, pub owner: Pubkey, pub amount: u64 }

/// Step 1: the reserves leave our vaults. Only ever safe because step 2 is in the same transaction.
#[derive(Accounts)]
pub struct MigrateRelease<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(address = launch.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [TOKEN_VAULT_SEED, launch.key().as_ref()], bump)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, launch.key().as_ref()], bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = migrator)]
    pub migrator_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = migrator)]
    pub migrator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: only a derivation seed, and it is checked against the CPMM program's own ownership
    /// in `migrate_confirm`. What matters here is that the pool it derives is recorded, so confirm
    /// cannot be pointed at a different one.
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: re-derived from Raydium's seeds above before it is read.
    pub pool_vault_0: UncheckedAccount<'info>,
    /// CHECK: re-derived from Raydium's seeds above before it is read.
    pub pool_vault_1: UncheckedAccount<'info>,
    /// CHECK: the CPMM program id the pool derives under; compared with confirm's.
    pub cp_swap_program: UncheckedAccount<'info>,
    /// Anyone may migrate. They hold the reserves for the rest of one transaction and no longer.
    pub migrator: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    /// Not always the same program as the launch token's: mainnet $REX is Token-2022.
    pub quote_token_program: Interface<'info, TokenInterface>,
}

/// Step 2: prove it. Nothing here is trusted — every address is re-derived from Raydium's seeds.
#[derive(Accounts)]
pub struct MigrateConfirm<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.mint.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(address = launch.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = launch.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: pinned to the real cp-swap deployment for this cluster.
    #[account(address = cpmm_program_id() @ PadError::Unauthorized)]
    pub cp_swap_program: UncheckedAccount<'info>,
    /// CHECK: only its key is used, as a seed in the pool derivation.
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: address and OWNER are both checked in the handler.
    pub pool_state: UncheckedAccount<'info>,
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    pub pool_vault_0: Box<InterfaceAccount<'info, TokenAccount>>,
    pub pool_vault_1: Box<InterfaceAccount<'info, TokenAccount>>,
}

/// Which Raydium deployment to trust. Pinned rather than passed in, so nobody can point a
/// "migration" at a program of their own and call that proof.
pub fn cpmm_program_id() -> Pubkey {
    #[cfg(feature = "devnet")]
    { CPMM_DEVNET.parse().unwrap() }
    #[cfg(not(feature = "devnet"))]
    { CPMM_MAINNET.parse().unwrap() }
}

#[event]
pub struct Migrated {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub quote: u64,
    pub tokens: u64,
}
