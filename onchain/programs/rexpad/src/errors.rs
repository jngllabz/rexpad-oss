use anchor_lang::prelude::*;

#[error_code]
pub enum PadError {
    #[msg("Amount must be greater than zero")] BadAmount,
    #[msg("Trade too small")] DustTrade,
    #[msg("Arithmetic overflow")] MathOverflow,
    #[msg("Pool is empty")] EmptyPool,
    #[msg("The curve does not hold enough quote to fund this sell — sell less")] InsufficientLiquidity,
    #[msg("Launchpad is paused")] Paused,
    #[msg("Fair Open window is still open")] WindowOpen,
    #[msg("Fair Open window has closed")] WindowClosed,
    #[msg("Launch is not accepting trades yet")] NotLive,
    #[msg("Slippage: output below the minimum requested")] Slippage,
    #[msg("Nothing to claim")] NothingToClaim,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("Invalid merkle proof")] BadProof,
    #[msg("Epoch pot exceeds the collected reward pot")] PotTooLarge,
    #[msg("Tax above the maximum allowed")] TaxTooHigh,
    #[msg("Fair Open window out of range")] BadWindow,
    #[msg("Insufficient position")] InsufficientPosition,
    #[msg("Not authorized")] Unauthorized,
    #[msg("The waterfall legs must add up to exactly what is left after the partner share")] WaterfallMismatch,
    #[msg("The waterfall has not been set yet")] WaterfallUnset,
    #[msg("Fees must be set in half-point (0.5%) steps")] FeeStep,
    #[msg("Holder rewards must be between 1% and 3%")] HolderOutOfRange,
    #[msg("Creator share is above its 1% ceiling")] CreatorOverCeiling,
    #[msg("Vault share is above its 1% ceiling")] VaultOverCeiling,
    #[msg("Burn share is above its 1% ceiling")] BurnOverCeiling,
    #[msg("Total fee is above the 4% cap")] FeeCapExceeded,
    #[msg("REX share can only be lowered")] TierCannotRise,
    #[msg("Nothing in that bucket")] EmptyBucket,
    // Named for the creator because that is who it used to apply to; it now binds every bidder,
    // since keying it on a key was decoration a second wallet walked straight past. The variant
    // keeps its name so the error discriminants do not shift under existing clients.
    #[msg("Any one bidder is capped at 20% of the raise")] DevCommitTooLarge,
    #[msg("Buyback ceiling is 1%")] BuybackOverCeiling,
    #[msg("No authority handover is pending")] NoPendingAuthority,
    #[msg("The revenue share is already set, and it is permanent — nothing can change or remove it")] PartnerLocked,
    #[msg("The revenue share cannot exceed 50% of REXPAD's own cut")] PartnerShareTooHigh,
    #[msg("That token account does not belong to the configured partner")] PartnerAccountMismatch,
    #[msg("This launch has not graduated yet, so there is nothing to migrate")]
    NotGraduated,
    #[msg("There are no reserves to migrate")]
    NothingToMigrate,
    #[msg("This launch is not mid-migration")]
    NotMigrating,
    #[msg("The pool was not created as promised, or does not hold the released reserves")]
    MigrationNotProven,
    #[msg("LP tokens still exist — somebody holds a claim on this liquidity")]
    LpNotBurned,
    #[msg("This launch has moved to a Raydium pool — trade it there")]
    AlreadyMigrated,
}
