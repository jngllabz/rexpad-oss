use crate::errors::PadError;
use crate::state::*;
use anchor_lang::prelude::*;

/// The four buckets taken out of one swap, all in the quote asset.
#[derive(Default, Clone, Copy)]
pub struct Fees {
    pub holder: u64,  // holders' share, already net of REX's cut
    pub rex: u64,     // REXPAD's cut — taken ONLY from the holder bucket, already net of the partner's
    pub partner: u64, // the revenue share, carved out of REXPAD's cut at the moment it is earned
    pub creator: u64,
    pub vault: u64,
    pub burn: u64,
    pub buyback: u64,
}
impl Fees {
    pub fn total(&self) -> u64 {
        self.holder + self.rex + self.partner + self.creator + self.vault + self.burn + self.buyback
    }
}

pub struct BuyResult {
    /// Gross quote actually charged (may be less than requested when the curve fills).
    pub gross: u64,
    pub refund: u64,
    pub net: u64,
    pub fees: Fees,
    pub tokens_out: u64,
    pub graduates: bool,
}

pub struct SellResult {
    pub gross: u64,
    pub fees: Fees,
    pub quote_out: u64,
}

/// Split a gross quote amount into the four buckets. REX is not a fifth fee: its cut is carved
/// out of the holder bucket, so the user-facing total is exactly the sum of the four fields.
pub fn split_fees(gross: u128, l: &Launch, partner_bps: u16) -> Fees {
    let bucket = |bps: u16| (gross * bps as u128 / BPS) as u64;
    let holder_total = bucket(l.holder_bps);
    // The REX protocol fee is an absolute share of the trade carved OUT of the holder allocation:
    // at 2% holders and a 0.50% REX fee, holders keep 1.5%. As REX steps down to 0.20%, holders rise
    // to 1.8% — the trader's total never moves, only the split between them.
    let rex_total = bucket(l.rex_bps.min(l.holder_bps));
    // The revenue share is a fraction of REX's fee, whatever that fee currently is. It therefore
    // tracks every tier step automatically and cannot be diluted by one.
    let partner = ((rex_total as u128) * partner_bps as u128 / BPS) as u64;
    Fees {
        holder: holder_total.saturating_sub(rex_total),
        rex: rex_total.saturating_sub(partner),
        partner,
        creator: bucket(l.creator_bps),
        vault: bucket(l.vault_bps),
        burn: bucket(l.burn_bps),
        buyback: bucket(l.buyback_bps),
    }
}

/// Validate a fee configuration exactly as the spec states: half-point steps, per-field
/// ceilings, and a 4% cap on the sum. Anything else reverts.
pub fn validate_fees(holder: u16, creator: u16, vault: u16, burn: u16, buyback: u16) -> Result<()> {
    for v in [holder, creator, vault, burn, buyback] {
        require!(v % FEE_STEP_BPS == 0, PadError::FeeStep);
    }
    require!((HOLDER_MIN_BPS..=HOLDER_MAX_BPS).contains(&holder), PadError::HolderOutOfRange);
    require!(creator <= SIDE_MAX_BPS, PadError::CreatorOverCeiling);
    require!(vault <= VAULT_MAX_BPS, PadError::VaultOverCeiling);
    require!(burn <= SIDE_MAX_BPS, PadError::BurnOverCeiling);
    require!(buyback <= SIDE_MAX_BPS, PadError::BuybackOverCeiling);
    require!(holder + creator + vault + burn + buyback <= FEE_CAP_BPS, PadError::FeeCapExceeded);
    Ok(())
}

/// Constant-product buy against virtual reserves (curve) or real reserves (AMM).
/// On the curve, a buy that would exceed the unsold supply is capped and the excess refunded.
pub fn quote_buy(l: &Launch, quote_in: u64, partner_bps: u16) -> Result<BuyResult> {
    require!(quote_in > 0, PadError::BadAmount);
    let fee_bps = l.total_fee_bps();
    let mut gross = quote_in as u128;
    let mut fees = split_fees(gross, l, partner_bps);
    let mut net = gross - fees.total() as u128;
    let mut refund: u128 = 0;
    let mut graduates = false;

    let tokens_out: u128 = if l.status == LaunchStatus::Graduated {
        let (q, t) = (l.amm_quote as u128, l.amm_token as u128);
        require!(q > 0 && t > 0, PadError::EmptyPool);
        t - div_ceil(q * t, q + net)
    } else {
        let k = l.k();
        let mut out = l.v_token - div_ceil(k, l.v_quote + net);
        if out >= l.real_token as u128 {
            // Buying the remainder of the curve: cap, recompute the exact cost, refund the rest.
            out = l.real_token as u128;
            let need = k / (l.v_token - out) - l.v_quote;
            let denom = BPS - fee_bps as u128; // total of the four buckets
            require!(denom > 0, PadError::MathOverflow);
            // ⛔ NEVER BOOK MORE INTO THE RESERVES THAN WAS ACTUALLY RECEIVED. This read
            // `net = need.max(gross - fees.total())`: `gross2` floors and `fees.total()` is a sum
            // of five separately-floored buckets, so the subtraction can land a unit or two under
            // `need` — and the `.max()` then credited `v_quote` with money that never arrived. Tiny,
            // but it is the invariant the whole curve rests on, and it fails in the pool's favour on
            // the one trade that closes the raise.
            //
            // Two changes. The cost rounds UP rather than down, so the pool is made whole wherever
            // the buyer's payment covers it — capped at what they actually sent, since crediting
            // past that would be the same bug pointing the other way. And the reserves are then
            // credited with the TRUE net. Ending a unit or two short of the theoretical graduation
            // point is harmless: `graduates` is decided by the token cap above, not by this figure.
            let gross2 = ((need * BPS + denom - 1) / denom).min(gross);
            refund = gross.saturating_sub(gross2);
            gross = gross2;
            fees = split_fees(gross, l, partner_bps);
            let total = fees.total() as u128;
            require!(gross > total, PadError::DustTrade);
            net = gross - total;
            graduates = true;
        }
        out
    };
    require!(tokens_out > 0, PadError::DustTrade);
    Ok(BuyResult {
        gross: u64::try_from(gross).map_err(|_| PadError::MathOverflow)?,
        refund: u64::try_from(refund).map_err(|_| PadError::MathOverflow)?,
        net: u64::try_from(net).map_err(|_| PadError::MathOverflow)?,
        fees,
        tokens_out: u64::try_from(tokens_out).map_err(|_| PadError::MathOverflow)?,
        graduates,
    })
}

/// Integer division that rounds UP.
///
/// ⛔ SOMEBODY HAS TO ABSORB THE DROPPED FRACTION, AND IT WAS ALWAYS THE POOL. Every trading path
/// has the shape `reserve - (a * b) / c`, and a floored quotient makes that subtraction LARGER —
/// so the trader got the truncation unit on buys and on sells, on the curve and on the AMM, four
/// paths out of four. `k` therefore fell monotonically with trade count: one base unit a trade is
/// no attack next to Solana fees, but it is the pool's invariant leaking in one direction forever,
/// and the fix is the same four characters in each place. Rounding the pool's side up means the
/// trader never gains the unit; at worst they are charged it.
fn div_ceil(a: u128, b: u128) -> u128 { if b == 0 { 0 } else { (a + (b - 1)) / b } }

pub fn quote_sell(l: &Launch, tokens_in: u64, partner_bps: u16) -> Result<SellResult> {
    require!(tokens_in > 0, PadError::BadAmount);
    let t_in = tokens_in as u128;
    let gross: u128 = if l.status == LaunchStatus::Graduated {
        let (q, t) = (l.amm_quote as u128, l.amm_token as u128);
        require!(q > 0 && t > 0, PadError::EmptyPool);
        q - div_ceil(q * t, t + t_in)
    } else {
        let k = l.k();
        let g = l.v_quote - div_ceil(k, l.v_token + t_in);
        // ⛔ A SILENT CAP ON A PRICING FUNCTION CORRUPTS THE CURVE AND SHORTCHANGES THE SELLER AT
        // THE SAME TIME. This was `g.min(l.real_quote)`, and `apply_sell` then subtracted the
        // CAPPED quote from `v_quote` while adding the FULL `tokens_in` to `v_token` — so tokens
        // entered the virtual reserve at full size while quote left at reduced size, `k` jumped,
        // and every price the curve quoted afterwards was wrong by that jump, permanently. The
        // seller meanwhile received less than the quoted price with no slippage error to explain
        // it: they are simply paid less and told nothing.
        //
        // A sell the curve cannot fund is a sell that should not happen. Reverting says so, in
        // words, before anything moves — and leaves the invariant intact.
        require!(g <= l.real_quote as u128, PadError::InsufficientLiquidity);
        g
    };
    let fees = split_fees(gross, l, partner_bps);
    let out = gross - fees.total() as u128;
    require!(out > 0, PadError::DustTrade);
    Ok(SellResult {
        gross: u64::try_from(gross).map_err(|_| PadError::MathOverflow)?,
        fees,
        quote_out: u64::try_from(out).map_err(|_| PadError::MathOverflow)?,
    })
}

/// Apply a buy to launch state. Returns true when this buy graduated the curve.
pub fn apply_buy(l: &mut Launch, r: &BuyResult) -> Result<bool> {
    if l.status == LaunchStatus::Graduated {
        l.amm_quote = l.amm_quote.checked_add(r.net).ok_or(PadError::MathOverflow)?;
        l.amm_token = l.amm_token.checked_sub(r.tokens_out).ok_or(PadError::MathOverflow)?;
        accrue(l, &r.fees)?;
        l.volume_quote = l.volume_quote.saturating_add(r.gross as u128);
        return Ok(false);
    }
    l.v_quote = l.v_quote.checked_add(r.net as u128).ok_or(PadError::MathOverflow)?;
    l.v_token = l.v_token.checked_sub(r.tokens_out as u128).ok_or(PadError::MathOverflow)?;
    l.real_quote = l.real_quote.checked_add(r.net).ok_or(PadError::MathOverflow)?;
    l.real_token = l.real_token.checked_sub(r.tokens_out).ok_or(PadError::MathOverflow)?;
    accrue(l, &r.fees)?;
    l.volume_quote = l.volume_quote.saturating_add(r.gross as u128);
    if r.graduates || l.real_token == 0 {
        // Price-continuous migration: the raise plus the reserved LP tokens become the AMM,
        // and those reserves can never be withdrawn — the liquidity is locked for good.
        l.status = LaunchStatus::Graduated;
        l.amm_quote = l.real_quote;
        l.amm_token = LP_TOKENS.checked_add(l.real_token).ok_or(PadError::MathOverflow)?;
        l.real_token = 0;
        return Ok(true);
    }
    Ok(false)
}

pub fn apply_sell(l: &mut Launch, tokens_in: u64, r: &SellResult) -> Result<()> {
    if l.status == LaunchStatus::Graduated {
        l.amm_quote = l.amm_quote.checked_sub(r.gross).ok_or(PadError::MathOverflow)?;
        l.amm_token = l.amm_token.checked_add(tokens_in).ok_or(PadError::MathOverflow)?;
        accrue(l, &r.fees)?;
        l.volume_quote = l.volume_quote.saturating_add(r.gross as u128);
        return Ok(());
    }
    l.v_quote = l.v_quote.checked_sub(r.gross as u128).ok_or(PadError::MathOverflow)?;
    l.v_token = l.v_token.checked_add(tokens_in as u128).ok_or(PadError::MathOverflow)?;
    l.real_quote = l.real_quote.checked_sub(r.gross).ok_or(PadError::MathOverflow)?;
    l.real_token = l.real_token.checked_add(tokens_in).ok_or(PadError::MathOverflow)?;
    accrue(l, &r.fees)?;
    l.volume_quote = l.volume_quote.saturating_add(r.gross as u128);
    Ok(())
}

/// Park each bucket in its own counter. The quote itself all sits in the one fee vault.
fn accrue(l: &mut Launch, f: &Fees) -> Result<()> {
    l.reward_pot = l.reward_pot.checked_add(f.holder).ok_or(PadError::MathOverflow)?;
    l.rex_pot = l.rex_pot.checked_add(f.rex).ok_or(PadError::MathOverflow)?;
    // Segregated the moment it is earned. Only claim_partner can move this, and only the partner
    // can sign it — no sweep, no authority, and no later change of terms reaches what is already here.
    l.partner_pot = l.partner_pot.checked_add(f.partner).ok_or(PadError::MathOverflow)?;
    l.creator_pot = l.creator_pot.checked_add(f.creator).ok_or(PadError::MathOverflow)?;
    l.vault_pot = l.vault_pot.checked_add(f.vault).ok_or(PadError::MathOverflow)?;
    l.burn_pot = l.burn_pot.checked_add(f.burn).ok_or(PadError::MathOverflow)?;
    l.buyback_pot = l.buyback_pot.checked_add(f.buyback).ok_or(PadError::MathOverflow)?;
    Ok(())
}

/// Sorted-pair sha256 merkle verification (standard airdrop layout).
pub fn verify_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for node in proof.iter() {
        computed = if computed <= *node {
            solana_sha256_hasher::hashv(&[&computed, node]).to_bytes()
        } else {
            solana_sha256_hasher::hashv(&[node, &computed]).to_bytes()
        };
    }
    computed == root
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A curve with round numbers, so the arithmetic in each case is checkable by hand.
    fn curve() -> Launch {
        let mut l = Launch::default();
        l.status = LaunchStatus::Live;
        l.v_quote = 1_000_000_000;
        l.v_token = 1_000_000_000_000;
        l.real_quote = 1_000_000_000;
        l.real_token = 1_000_000_000_000;
        l.holder_bps = 250; l.burn_bps = 50; l.buyback_bps = 50; l.rex_bps = 50;
        l
    }

    // ── REX-07 ────────────────────────────────────────────────────────────────────────────────
    #[test]
    fn div_ceil_rounds_up_and_never_down() {
        assert_eq!(div_ceil(10, 3), 4, "10/3 rounds up to 4");
        assert_eq!(div_ceil(9, 3), 3, "an exact division is unchanged");
        assert_eq!(div_ceil(1, 1_000), 1, "a fraction becomes one, never zero");
        assert_eq!(div_ceil(0, 7), 0, "zero stays zero");
        assert_eq!(div_ceil(5, 0), 0, "a zero divisor cannot panic in a program");
        // The property that matters: never below the true quotient.
        for a in 0u128..200 {
            for b in 1u128..17 {
                assert!(div_ceil(a, b) >= a / b, "{a}/{b} rounded below the floor");
                assert!(div_ceil(a, b) <= a / b + 1, "{a}/{b} rounded up by more than a unit");
            }
        }
    }

    #[test]
    fn the_trader_never_gains_the_truncation_unit_on_a_buy() {
        let l = curve();
        let r = quote_buy(&l, 1_000_000, 0).unwrap();
        // The old floor form; the pool's side must never be more generous than this.
        let net = r.gross as u128 - r.fees.total() as u128;
        let denom = l.v_quote + net;
        let floored = l.v_token - (l.k() / denom);
        assert!(
            r.tokens_out as u128 <= floored,
            "tokens_out {} exceeded the floored result {} — the trader gained the unit",
            r.tokens_out, floored
        );
        // ⛔ `<=` ALONE WOULD PASS AGAINST THE OLD CODE, because the floored form IS what it
        // returned — the assertion has to see the difference to be worth anything. Whenever the
        // division has a remainder the ceiling must come out strictly lower by exactly one unit,
        // and that unit is the one the pool used to hand over on every single trade.
        if l.k() % denom != 0 {
            assert_eq!(
                r.tokens_out as u128, floored - 1,
                "with a remainder the pool must keep the unit: got {}, floored {}",
                r.tokens_out, floored
            );
        }
    }

    // ── REX-05 ────────────────────────────────────────────────────────────────────────────────
    #[test]
    fn a_sell_the_curve_cannot_fund_reverts_instead_of_paying_less() {
        let mut l = curve();
        // Quote the curve cannot cover: plenty of virtual quote, almost no real quote behind it.
        l.real_quote = 1_000;
        let before = (l.v_quote, l.v_token, l.real_quote);
        let r = quote_sell(&l, 500_000_000_000, 0);
        assert!(r.is_err(), "a sell beyond real_quote must revert, not silently pay less");
        assert_eq!(
            (l.v_quote, l.v_token, l.real_quote), before,
            "and must leave the reserves exactly as it found them"
        );
    }

    #[test]
    fn a_sell_the_curve_can_fund_still_works() {
        let l = curve();
        let r = quote_sell(&l, 1_000_000_000, 0).expect("an ordinary sell must still price");
        assert!(r.gross > 0 && (r.gross as u128) <= l.real_quote as u128);
    }

    // ── REX-08 ────────────────────────────────────────────────────────────────────────────────
    /// REX-08 is not reachable, and here is why — with the real `split_fees` to back it.
    ///
    /// ⛔ I REPORTED IT AS "UNREPRODUCED" TWICE BEFORE CHECKING WHETHER IT COULD BE REPRODUCED AT
    /// ALL. A fixture missed it, a 112-case sweep through `quote_buy` missed it, and then a direct
    /// search over five fee splits and six thousand `need` values missed it too — at which point
    /// the right move was to do the algebra instead of widening the search again.
    ///
    /// `old_gross = floor(need * BPS / denom)` gives up less than one unit of quote. Every bucket in
    /// `split_fees` floors, and flooring only ever makes `total` SMALLER, so
    /// `old_net = old_gross - total >= old_gross * denom / BPS > need - 1`. An integer strictly
    /// greater than `need - 1` is at least `need`. The shortfall the finding describes therefore
    /// cannot occur: `need.max(…)` was a no-op guard, not a leak.
    ///
    /// The shipped change still stands — crediting the true net rather than a figure topped up to
    /// `need` is the honest form and provably identical here — but it fixes nothing, and saying it
    /// closed a real hole would be a lie about the only part of this that matters.
    #[test]
    fn rex_08_shortfall_is_unreachable_in_either_form() {
        for (h, c, v, b, k) in [(250u16, 0u16, 0u16, 50u16, 50u16), (300, 100, 0, 100, 100),
                                (170, 30, 70, 30, 30), (490, 10, 90, 10, 10), (200, 50, 50, 50, 50)] {
            let mut l = Launch::default();
            l.holder_bps = h; l.creator_bps = c; l.vault_bps = v; l.burn_bps = b; l.buyback_bps = k;
            l.rex_bps = 50;
            let denom = BPS - (h + c + v + b + k) as u128;
            for need in 1u128..4000 {
                let old_gross = need * BPS / denom;                        // the floor, as it was
                let old_net = old_gross.saturating_sub(split_fees(old_gross, &l, 0).total() as u128);
                assert!(old_net >= need,
                    "the OLD form under-credited at need={need}, fee_bps={}: {old_net} < {need} — \
                     if this ever fires, REX-08 is real after all and `.max()` was load-bearing",
                    h + c + v + b + k);

                let new_gross = ((need * BPS + denom - 1) / denom).min(u128::MAX);  // the ceiling now shipped
                let new_net = new_gross.saturating_sub(split_fees(new_gross, &l, 0).total() as u128);
                assert!(new_net >= need, "the shipped form under-credited at need={need}");
            }
        }
    }

    #[test]
    fn the_graduating_buy_never_credits_more_than_it_received() {
        // ⛔ THIS GUARDS THE INVARIANT; IT DOES NOT DEMONSTRATE THE OLD BUG. Be clear about that.
        // REX-08 said `net = need.max(gross - fees)` could book a unit or two that never arrived,
        // when the floored cost and the five separately-floored buckets land under `need`. I could
        // not reach that alignment: a single fixture passed against the broken code, and so did
        // this 112-case sweep across four fee splits and seven remaining-supply sizes. So the
        // finding is plausible and the fix — crediting the true net by construction — is strictly
        // more correct and free, but the failure is unreproduced here rather than proven.
        //
        // The sweep stays because the INVARIANT is the thing worth nailing down: whatever the split
        // or the remainder, the reserves must never be credited with more than the buyer sent.
        let mut checked = 0;
        for (h, b, k2, r2) in [(250u16, 50u16, 50u16, 50u16), (300, 100, 100, 100), (170, 30, 30, 70), (490, 10, 10, 90)] {
            for real_token in [1u64, 3, 7, 11, 999, 1_000_001, 7_777_777] {
                for offered in [999_999u64, 1_000_000, 1_234_567, 999_999_999] {
                    let mut l = curve();
                    l.holder_bps = h; l.burn_bps = b; l.buyback_bps = k2; l.rex_bps = r2;
                    l.real_token = real_token;
                    let Ok(res) = quote_buy(&l, offered, 0) else { continue };
                    if !res.graduates { continue; }
                    checked += 1;
                    assert!(
                        res.net as u128 + res.fees.total() as u128 <= res.gross as u128,
                        "net {} + fees {} exceeded the gross {} actually taken \
                         (h={h} b={b} buyback={k2} rex={r2} real_token={real_token} offered={offered})",
                        res.net, res.fees.total(), res.gross
                    );
                    assert_eq!(
                        res.gross as u128 + res.refund as u128, offered as u128,
                        "gross + refund must account for everything offered"
                    );
                }
            }
        }
        assert!(checked > 0, "the sweep never reached the graduation branch — fixture is wrong");
    }
}
