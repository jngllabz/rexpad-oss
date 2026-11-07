//! REX Chain transfer hook — launch rules the chain itself enforces.
//!
//! The pitch is simple and the implementation has to earn it: a trade that breaks the rule never
//! lands. Not "a bot sells it back", not "we snapshot and claw it back later", not "the website
//! refuses" — Solana runs this program inside every single transfer of the mint, and if it returns
//! an error the transfer does not happen. There is nothing to babysit and nothing to trust.
//!
//! THE ONE THING THAT CANNOT BE FIXED LATER: a transfer hook is a Token-2022 extension, and
//! extensions can only be written while the mint is being created. A mint that launches without the
//! extension can NEVER have one added — not by an upgrade, not by the authority, not by anyone. So
//! this is a decision taken once per coin, at birth, and the program that enforces it had better be
//! right before the first one ships.
//!
//! What the rules deliberately are NOT: they cannot move anybody's tokens, mint, freeze an account,
//! or redirect a transfer somewhere else. A hook can only say no. That ceiling is the point — it is
//! what makes "rules built into the token" something a buyer can accept rather than a backdoor
//! wearing a friendly name.
//!
//! ⛔ ONE HONEST QUALIFICATION, because the paragraph above overstated it and a buyer may be
//! relying on it. "A hook can only say no" is true instruction by instruction, but saying no to
//! EVERY transfer is what `freeze` does, and in money terms a permanent refusal is not
//! meaningfully different from confiscation. Two things bound it, and both are deliberate:
//! `freeze` is callable only inside the opening guard window, and `renounce` now refuses while
//! frozen — so the one unrecoverable combination, freeze-then-renounce, cannot be reached. What
//! remains is a halt that someone still holds the authority to lift.
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("9YnrpwYYhzKAqz25PncsafkGptc2CZUJsFZRcN5G1hrB");

pub const RULES_SEED: &[u8] = b"rules";
pub const META_SEED: &[u8] = b"extra-account-metas";
/// Blocked wallets are walked on EVERY transfer, so the list is capped: an unbounded one would make
/// the token progressively more expensive to trade until it stopped working altogether.
pub const MAX_BLOCKED: usize = 24;

#[program]
pub mod rexhook {
    use super::*;

    /// Write the rules and the account list Token-2022 needs in order to call us.
    ///
    /// Both happen in one instruction on purpose. The extra-account-meta list is what tells the
    /// token program which accounts to pass into `execute`; without it every transfer fails, and a
    /// mint that carries the extension but has no list is a token nobody can move.
    pub fn initialize(
        ctx: Context<Initialize>,
        max_wallet: u64,
        guard_secs: i64,
        guard_max_wallet: u64,
    ) -> Result<()> {
        require!(guard_secs >= 0 && guard_secs <= 86_400, HookError::BadGuard);
        // A guard that is LOOSER than the steady-state cap is almost certainly a mistake, and the
        // mistake only shows up in the minutes when it matters most.
        require!(
            guard_max_wallet == 0 || max_wallet == 0 || guard_max_wallet <= max_wallet,
            HookError::GuardLooserThanCap
        );
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.rules;
        r.mint = ctx.accounts.mint.key();
        r.authority = ctx.accounts.authority.key();
        r.max_wallet = max_wallet;
        r.guard_until = if guard_secs > 0 { now + guard_secs } else { 0 };
        r.guard_max_wallet = guard_max_wallet;
        r.frozen = false;
        r.blocked = Vec::new();
        r.bump = ctx.bumps.rules;

        // The only account `execute` needs beyond the four the token program already passes.
        let metas = [ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal { bytes: RULES_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
            false,
            false,
        )?];
        let size = ExtraAccountMetaList::size_of(metas.len())?;
        let lamports = Rent::get()?.minimum_balance(size);
        let mint_key = ctx.accounts.mint.key();
        let signer: &[&[&[u8]]] = &[&[META_SEED, mint_key.as_ref(), &[ctx.bumps.extra_account_meta_list]]];
        system_program::create_account(
            CpiContext::new_with_signer(
                // A Pubkey, not an AccountInfo — this Anchor takes the program by key.
                ctx.accounts.system_program.key(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
                signer,
            ),
            lamports,
            size as u64,
            &crate::ID,
        )?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &metas,
        )?;
        emit!(RulesSet { mint: mint_key, max_wallet, guard_until: r.guard_until, guard_max_wallet });
        Ok(())
    }

    /// The hook. Token-2022 calls this inside every transfer; returning an error voids the transfer.
    ///
    /// By the time we are called the amounts have ALREADY moved, so `destination.amount` is the
    /// post-transfer balance. That is what makes a cap checkable at all — we are asked to approve
    /// the world as it would be, not to predict it.
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let r = &ctx.accounts.rules;
        require!(!r.frozen, HookError::Frozen);

        let from = ctx.accounts.source.owner;
        let to = ctx.accounts.destination.owner;
        if !r.blocked.is_empty() {
            require!(!r.blocked.contains(&from) && !r.blocked.contains(&to), HookError::Blocked);
        }

        let now = Clock::get()?.unix_timestamp;
        let cap = if r.guard_until > 0 && now < r.guard_until { r.guard_max_wallet } else { r.max_wallet };
        if cap > 0 && !r.exempt.contains(&to) {
            // Checked against the DESTINATION's whole balance, not against the size of this
            // transfer: a cap that only looked at one transfer would be defeated by sending twice.
            // Exempt owners are skipped entirely — see `HookRules::exempt`.
            require!(ctx.accounts.destination.amount <= cap, HookError::OverWalletCap);
        }
        let _ = amount;
        Ok(())
    }

    /// Rules may only ever be LOOSENED, and the authority can be given up for good.
    ///
    /// This is the asymmetry that makes the feature safe to buy into. A launch cannot tighten a cap
    /// around holders after they have bought, cannot add somebody to the blocklist to trap them, and
    /// cannot extend the guard. Everything here moves in the holder's favour or not at all.
    pub fn relax(ctx: Context<Admin>, max_wallet: u64, clear_guard: bool) -> Result<()> {
        let r = &mut ctx.accounts.rules;
        if max_wallet != r.max_wallet {
            // 0 means "no cap", which is the loosest possible setting.
            require!(
                max_wallet == 0 || (r.max_wallet != 0 && max_wallet > r.max_wallet),
                HookError::WouldTighten
            );
            r.max_wallet = max_wallet;
        }
        if clear_guard {
            r.guard_until = 0;
            r.guard_max_wallet = 0;
        }
        emit!(RulesSet { mint: r.mint, max_wallet: r.max_wallet, guard_until: r.guard_until, guard_max_wallet: r.guard_max_wallet });
        Ok(())
    }

    /// Unblock a wallet. There is no `block` — see below.
    /// Exempt a vault authority from `max_wallet`. Loosens only — it can never refuse a transfer
    /// that would otherwise succeed — so unlike `block` it is not restricted to the guard window.
    pub fn exempt_add(ctx: Context<Admin>, who: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.rules;
        require!(r.exempt.len() < 8, HookError::ExemptFull);
        if !r.exempt.contains(&who) { r.exempt.push(who); }
        emit!(Exempted { mint: r.mint, who, exempt: true });
        Ok(())
    }
    /// ⛔ TIGHTENS, so it is guard-window only — the same rule `block` follows. Removing an
    /// exemption can start refusing transfers that were succeeding a moment earlier, and a token
    /// whose rules can be tightened after the opening is a freeze authority with extra steps.
    pub fn exempt_remove(ctx: Context<Admin>, who: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.rules;
        require!(r.guard_until > 0 && now < r.guard_until, HookError::GuardOver);
        r.exempt.retain(|x| x != &who);
        emit!(Exempted { mint: r.mint, who, exempt: false });
        Ok(())
    }
    pub fn unblock(ctx: Context<Admin>, who: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.rules;
        r.blocked.retain(|x| x != &who);
        emit!(Unblocked { mint: r.mint, who });
        Ok(())
    }

    /// Block a wallet — ONLY during the guard window, and only up to the cap.
    ///
    /// This exists for snipers in the opening seconds and is deliberately crippled everywhere else:
    /// once the guard has passed, nobody can be blocked by anyone, ever. A permanent blocklist on a
    /// token is a freeze authority with extra steps, and this program refuses to be that.
    pub fn block(ctx: Context<Admin>, who: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.rules;
        require!(r.guard_until > 0 && now < r.guard_until, HookError::GuardOver);
        require!(r.blocked.len() < MAX_BLOCKED, HookError::BlocklistFull);
        require!(!r.blocked.contains(&who), HookError::AlreadyBlocked);
        r.blocked.push(who);
        emit!(Blocked { mint: r.mint, who });
        Ok(())
    }

    /// Emergency halt, and it can only ever be switched OFF again once used — see `thaw`.
    pub fn freeze(ctx: Context<Admin>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.rules;
        require!(r.guard_until > 0 && now < r.guard_until, HookError::GuardOver);
        r.frozen = true;
        Ok(())
    }
    pub fn thaw(ctx: Context<Admin>) -> Result<()> {
        ctx.accounts.rules.frozen = false;
        Ok(())
    }

    /// Hand the rules to nobody. After this the token's rules are whatever they are, forever.
    ///
    /// ⛔ REFUSES WHILE FROZEN, BECAUSE THE TWO TOGETHER ARE NOT REVERSIBLE BY ANYONE.
    ///
    /// `freeze` makes `execute` reject every transfer of the mint; `thaw` clears it and is the only
    /// way back. `thaw` runs through `Admin`, which requires a non-default authority — so renouncing
    /// while frozen deletes the only account permitted to lift the freeze. The mint is then
    /// untransferable forever, by anyone, with no recovery: this program is welded into the mint at
    /// creation and no upgrade reaches an existing one.
    ///
    /// The trap is the shape of it. `renounce` is the REASSURING instruction — the one a maintainer
    /// calls to prove they can never interfere again, and the one a buyer wants to see called. Two
    /// ordinary actions, one signer, one transaction, and every holder is left holding something
    /// permanently frozen.
    ///
    /// This also closes a gap between the code and the promise in this file's header, which tells a
    /// buyer the rules "cannot move anybody's tokens" and that a hook "can only say no". Saying no
    /// to everyone, forever, is economically indistinguishable from confiscation.
    pub fn renounce(ctx: Context<Admin>) -> Result<()> {
        let r = &mut ctx.accounts.rules;
        require!(!r.frozen, HookError::Frozen);
        r.authority = Pubkey::default();
        emit!(Renounced { mint: r.mint });
        Ok(())
    }
}

/// Token-2022 does not call this program the way a client does.
///
/// It dispatches with the TRANSFER HOOK INTERFACE discriminator — a value defined by the interface,
/// not by Anchor — so Anchor's own `global:execute` selector never matches and every transfer dies
/// with "instruction not found" before a single rule is read. The fallback is what bridges the two:
/// it recognises the interface's Execute, unpacks the amount, and hands it to the real handler.
///
/// Without this the token is simply untransferable, which is a spectacular way to brick a launch.
#[allow(deprecated)]
pub fn fallback<'info>(
    program_id: &'info Pubkey,
    accounts: &'info [AccountInfo<'info>],
    data: &'info [u8],
) -> Result<()> {
    match TransferHookInstruction::unpack(data) {
        Ok(TransferHookInstruction::Execute { amount }) => {
            // Leaked deliberately: the generated handler borrows for 'info, and this is eight bytes
            // on a stack frame that ends with the transaction either way.
            let bytes: &'info [u8] = Box::leak(Box::new(amount.to_le_bytes()));
            __private::__global::execute(program_id, accounts, bytes)
        }
        _ => Err(ProgramError::InvalidInstructionData.into()),
    }
}

#[account]
#[derive(InitSpace)]
pub struct HookRules {
    pub mint: Pubkey,
    /// Default means renounced: nothing can change the rules again.
    pub authority: Pubkey,
    /// Most a wallet may hold, in raw units. 0 = no cap.
    pub max_wallet: u64,
    /// Tighter rules apply until this timestamp. 0 = no guard.
    pub guard_until: i64,
    pub guard_max_wallet: u64,
    pub frozen: bool,
    #[max_len(24)]
    pub blocked: Vec<Pubkey>,
    /// ⛔ OWNERS THE WALLET CAP DOES NOT APPLY TO — WITHOUT THIS, SUCCESS BREAKS THE LAUNCH.
    ///
    /// `max_wallet` is checked against the destination's whole post-transfer balance with no
    /// exception, and program vaults are destinations: a launchpad's quote and token vaults
    /// accumulate everyone's deposits by design. A cap sized for a retail wallet is passed by a
    /// protocol vault almost immediately, so the failure mode is "the launch works until it is
    /// popular, then halts" — and the halt looks like an anti-whale rule doing its job.
    ///
    /// Entries are token-account OWNERS, not token accounts, so one entry covers every account a
    /// given vault authority holds. Deliberately small: this is for a handful of known program
    /// authorities, not a general whitelist, and every entry is a wallet the cap stops binding on.
    #[max_len(8)]
    pub exempt: Vec<Pubkey>,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    // ⛔ THE SIGNER MUST BE THE MINT'S OWN AUTHORITY, OR THE RULES ARE FIRST-COME-FIRST-SERVED.
    //
    // Nothing here linked the signer to the mint, so whoever landed `initialize` first became the
    // permanent owner of that mint's rules — and could set them to something hostile and, with
    // HOOK-01, freeze the mint before it ever traded. The real creator's own call then fails
    // because the PDA is taken.
    //
    // Our deploy path creates the mint and initialises in one transaction, which leaves no race
    // window — but that is a property of a script nobody reading this program can see, and it holds
    // only until someone adds a retry or splits a transaction that grew too large. This makes the
    // protection structural rather than circumstantial.
    #[account(constraint = mint.mint_authority == COption::Some(authority.key())
        @ HookError::NotMintAuthority)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = payer, space = 8 + HookRules::INIT_SPACE,
              seeds = [RULES_SEED, mint.key().as_ref()], bump)]
    pub rules: Account<'info, HookRules>,
    /// CHECK: created and written here; its address is fixed by the seeds Token-2022 will derive.
    #[account(mut, seeds = [META_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The account order is fixed by the transfer-hook interface: source, mint, destination, owner,
/// extra-account-meta list, then whatever that list asked for.
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint)]
    pub source: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the source's delegate or owner, as handed over by the token program.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated by its seeds.
    #[account(seeds = [META_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [RULES_SEED, mint.key().as_ref()], bump = rules.bump,
              constraint = rules.mint == mint.key() @ HookError::WrongMint)]
    pub rules: Account<'info, HookRules>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [RULES_SEED, rules.mint.as_ref()], bump = rules.bump,
              constraint = rules.authority != Pubkey::default() @ HookError::Renounced,
              has_one = authority @ HookError::NotAuthority)]
    pub rules: Account<'info, HookRules>,
    pub authority: Signer<'info>,
}

#[event]
pub struct RulesSet { pub mint: Pubkey, pub max_wallet: u64, pub guard_until: i64, pub guard_max_wallet: u64 }
#[event]
pub struct Blocked { pub mint: Pubkey, pub who: Pubkey }
#[event]
pub struct Unblocked { pub mint: Pubkey, pub who: Pubkey }
#[event]
pub struct Renounced { pub mint: Pubkey }
#[event]
pub struct Exempted { pub mint: Pubkey, pub who: Pubkey, pub exempt: bool }

#[error_code]
pub enum HookError {
    #[msg("transfers are halted")]
    Frozen,
    #[msg("only the mint's own authority may set up its rules")]
    NotMintAuthority,
    #[msg("this wallet is blocked for the opening window")]
    Blocked,
    #[msg("that would put the wallet over the maximum holding")]
    OverWalletCap,
    #[msg("rules can only be loosened, never tightened")]
    WouldTighten,
    #[msg("the opening window has passed")]
    GuardOver,
    #[msg("the blocklist is full")]
    BlocklistFull,
    #[msg("the exemption list is full")]
    ExemptFull,
    #[msg("already blocked")]
    AlreadyBlocked,
    #[msg("the rules have been renounced and cannot change")]
    Renounced,
    #[msg("not the rules authority")]
    NotAuthority,
    #[msg("rules do not belong to this mint")]
    WrongMint,
    #[msg("guard window must be between 0 and 24 hours")]
    BadGuard,
    #[msg("the guard cap must be tighter than the standing cap")]
    GuardLooserThanCap,
}
