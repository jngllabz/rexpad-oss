# REX Chain → Meteora DBC — full scope

**Decision:** Rex dev group, 4 Oct. Replace REX Chain's own bonding curve with Meteora's
Dynamic Bonding Curve so every launch is discoverable by CA from block one, and take
revenue as claimable pool fees so it does not stop at graduation.

**Status of the unknown that gated this:** settled. `tools/dbc_spike.mjs` created a
Token-2022 mint on devnet carrying exactly REX's extension set (`metadataPointer` +
`tokenMetadata`, no transfer fee, no hook) and called `createConfig` with it as the quote.
**Accepted, no TokenBadge.** REX-quoted launches on DBC are permissionless.

---

## 1. Why, in one paragraph

DexScreener indexes specific Solana programs — sampled live: `raydium, meteora, orca,
pumpswap, pumpfun, meteoradbc`. REX's curve is its own program, so it is invisible by
construction, which is why both live mainnet coins return `pairs: null` and Jupiter says
"not tradable". Worse, and only visible from reading the program: `migrate_confirm`
requires `lp_mint.supply == 0`, `buy()` rejects `Migrated`, and **no LP-fee claim
instruction exists** — so once a coin graduates to Raydium, REX Chain earns nothing from
it ever again. Fees exist only where the coin is invisible; where it is visible they are
zero. DBC fixes both at once: `meteoradbc` is indexed, and `partnerPermanentLockedLiquidity`
keeps earning after migration instead of burning the LP.

---

## 2. Architecture, before and after

| | today | after |
|---|---|---|
| curve | `rexpad` program, custom | Meteora DBC (`dbcij3LW…`) |
| indexed pre-graduation | ❌ never | ✅ `meteoradbc` from block one |
| graduation target | Raydium CPMM, **LP burned** | DAMM v2 (`cpamdpZC…`), **LP permanently locked** |
| revenue after graduation | **zero** | claimable trading fees, forever |
| fee enforcement | per-swap, on-chain, 5 buckets | one pool fee, claimed + split by our crank |
| fee denomination | quote asset | quote asset (`collectFeeMode: QuoteToken`) |
| Fair Open | seeds the custom curve | seeds the DBC pool |
| holder rewards | merkle epochs, on-chain claim | **unchanged** — funded from claimed fees |

**One DBC config per launch**, not one shared config. A config carries the fee parameters
and the `feeClaimer`, so per-launch configs are what preserve "the launcher sets their own
buckets". `createConfigAndPool` and `createConfigAndPoolWithFirstBuy` exist precisely for
this, and the latter folds the dev buy into the same transaction.

---

## 3. The fee model — the hard part

This is where the design actually changes, and it should be understood before any code.

**Today:** five buckets (holder 1–3%, creator ≤1%, vault ≤2%, burn ≤1%, buyback ≤1%),
enforced per swap inside our program, 5% ceiling checked on chain. The split is arithmetic
the chain guarantees.

**After:** a DBC pool has **one** base fee. It accrues in the quote asset and is split by
DBC into a partner share and a creator share (`creatorTradingFeePercentage`). We claim each
side and fan it out ourselves.

```
DBC pool fee (quote)
 ├── creator share   → claimCreatorTradingFee  → the launcher's cut
 └── partner share   → claimPartnerTradingFee  → REX Chain
      └── split by OUR crank into:
            holder reward pot   (funds the existing merkle epochs)
            vault leg
            burn leg
            buyback leg
            REX income → the five-wallet waterfall (already built)
```

**What this costs, stated plainly:** the bucket split stops being enforced by the chain and
becomes enforced by code we run. A crank that stops running stops paying. Mitigations, all
of which are scope:

- the claim-and-split must be **idempotent and restartable** — every claim recorded with
  its signature before the split is attempted, so a crash cannot double-pay or lose a claim;
- the split must be **derived from the stored per-launch bps**, never retyped;
- the remainder from integer division **stays in the pot** for the next run rather than
  being assigned to whichever leg is computed last (same rule as `buyback.mjs` today);
- a **public ledger page** showing claimed vs distributed per launch, so the split is
  auditable by anyone even though it is no longer on-chain.

**Fee ceiling:** DBC's base fee is set in bps with a scheduler. The 1–3% holder range and
the 5% ceiling become a constraint on the single pool fee plus how we divide it. The UI must
stop presenting five freely-set sliders that the chain validates, and start presenting one
pool fee plus a division of it — otherwise the form promises enforcement that no longer exists.

---

## 4. Workstreams

### W1 — Launch path (largest)
- **New** `lib/meteora.mjs`: config+pool creation, swap quoting, fee claiming, migration.
  Wraps `PartnerService`, `CreatorService`, `PoolService`, `MigrationService`.
- `lib/chain.mjs`: `buildCreateLaunch` / `buildBuy` / `buildSell` / `buildMigrate` get DBC
  equivalents. The old ones stay until existing launches are retired (see W7).
- `server.mjs`: `/api/chain/build/*` routes dispatch per launch venue.
- Launch tx shape: `createConfigAndPoolWithFirstBuy` — config, pool and the dev buy in one
  signature, which is also fewer wallet prompts than today.

### W2 — Fee claim + distribution crank
- **New** `tools/fee_crank.mjs`, modelled on the existing `buyback_crank.mjs` and
  `vault_crank.mjs`: **plans by default, `--execute` to act**, never signs to plan.
- Reads accrued fees per pool (`getPoolFeeMetrics` / `getPoolsFeesByConfig`).
- Claims partner + creator sides, records each claim with its signature **before** splitting.
- Splits the partner side into holder pot / vault / burn / buyback / REX income.
- REX income then flows into the **existing** five-wallet waterfall — `distribute` is already
  written and live on devnet, so this plugs into it rather than replacing it.

### W3 — Fair Open
Survives, and is still REX's differentiator. The sealed window collects commitments; at the
bell, instead of opening a custom curve, it **creates the DBC pool and executes the clearing
buy**. One uniform price still holds. Needs: escrow unchanged, settle path rewritten, and a
decision on whether the clearing buy is one `createConfigAndPoolWithFirstBuy` or a pool
creation followed by a batched buy (latter is safer against partial failure).

### W4 — Indexer
- `lib/indexer.mjs` currently reads `rexpad` launches via `program().account.launch.all()`.
  Adds a DBC reader using `StateService.getPoolsByConfig` / `getPoolByBaseMint` and DBC swap
  events.
- `tokens` rows gain `venue` (`rexpad` | `dbc`) and the pool/config addresses.
- **The DexScreener self-host adapter becomes redundant** for DBC launches and can be
  retired once nothing is left on the old curve — Meteora is indexed natively.

### W5 — Holder rewards (Diamond Hands)
**Unchanged in mechanism** — merkle epochs, on-chain claim, the `hold`/`flat` modes shipped
3 Oct. The only change is where the pot comes from: the claimed partner fee instead of
per-swap accrual. `runEpoch` already takes the pot as a number, so this is a funding-source
change, not a rewrite.

### W6 — Vaults (Fco's ask, 4 Oct) — **SOLVED, needs a policy choice**
Two legs, both must keep working:
- **REX's own vault leg** — the 500 bps waterfall leg, already live on devnet.
- **The per-token vault bucket** — funded from the claimed fee.

The old `vault_crank` targets Raydium CPMM, and graduated DBC launches land on DAMM v2.
That looked like a straight port; it is better than that. **CPMM made the vault's job
impossible**: a constant-product deposit needs BOTH sides, the vault is funded in quote
alone, and acquiring the token side is a market buy the crank rightly refused to make. So
the vault sat on money it could not deploy.

**DAMM v2 is concentrated liquidity — a position is a PRICE RANGE.** A range entirely below
spot is made of quote and nothing else. The vault can therefore deploy quote-only liquidity
with no market buy at all, and a bid sitting below the market earning fees while it waits is
exactly what the site already promises. Verified: `getDepositQuote` takes
`minSqrtPrice`/`maxSqrtPrice`, and `bidRange()` stays entirely below spot at every depth.

`lib/vault2.mjs` implements three strategies so the decision is a setting, not another
rebuild:

| | what it does | needs a market buy? | earns fees? |
|---|---|---|---|
| **`bid`** (default) | single-sided quote below spot — a standing bid that buys the dip | **no** | yes |
| `both` | full-range on both sides — deepest liquidity | yes | yes, most |
| `lock` | buy the token and lock it forever | yes | no |

**The open question is which, and it is a policy question for the team, not a technical
one.** `bid` is the default because it is the only one that deploys the vault without
anyone making a trading decision, and the only one faithful to the copy already on the site.

### W7 — Existing launches
Two live mainnet coins (`BREX`, `MWAI`) are on the old curve, both `live`, neither graduated.
Options, for the team to choose:
- **leave them** on the old program until they graduate naturally — simplest, no new risk;
- **migrate them** — needs a bespoke path, real money, and should not be invented under time
  pressure.
Recommendation: leave them. The old program keeps running; new launches go to DBC.

### W8 — UI
- Launch form: five sliders → one pool fee + its division (see §3).
- Coin page: show the Meteora pool, DexScreener/Jupiter links that now actually resolve.
- `/learn`: the fee section is rewritten — it currently promises on-chain enforcement of the
  split, which will no longer be true.
- The "graduation" copy changes meaning: it is now a migration to a locked-LP pool that
  **keeps paying**, which is a better story than today's.

---

## 5. What is preserved, and what is genuinely lost

**Preserved:** Fair Open and its single clearing price · Diamond Hands and both reward modes
· the merkle claim rail · the five-wallet waterfall and Cyrus's 10% · referrals · points ·
the burn.

**Lost or weakened — the team should agree to these explicitly:**
1. Per-swap on-chain enforcement of the bucket split. Becomes our crank.
2. Free half-point bucket sliders to a 5% ceiling. Becomes one pool fee plus a division.
3. Our own curve shape. DBC's curve is configurable but it is theirs.
4. The DexScreener adapter work becomes dead code for new launches.

---

## 6. Risks

| risk | mitigation |
|---|---|
| crank stops → nobody is paid | idempotent, restartable, signature-recorded claims; alerting; public ledger page |
| DBC changes quote-mint rules and REX needs a badge after all | `tools/dbc_spike.mjs` is kept as the reproduction; re-run it in CI |
| migration to DAMM v2 fails mid-way | DBC owns this path; test the full curve→migration cycle on devnet before mainnet |
| fee split disputes | publish claimed-vs-distributed per launch; the split is derived from stored bps, never retyped |
| two venues live at once | `venue` column from day one; never infer venue from shape |

---

## 7. Sequencing

1. **W1 + W4 on devnet** — one launch end to end on DBC, visible on DexScreener devnet.
   This is the proof. Everything else is downstream.
2. **W2** — fee claim and split, plan-only first, verified against a real accrued fee.
3. **W3** — Fair Open settling into a DBC pool.
4. **W5** — repoint the reward pot. Small.
5. **W8** — UI, including the honest rewrite of the fee copy.
6. **W6** — vaults, once Fco clarifies.
7. **Mainnet**, with W7 decided.

Steps 1–3 are the real work. 4, 5 and 7 are small. 6 is unknown until clarified.

---

## 8. Test plan

- `tools/dbc_spike.mjs` — keep, extend to the full cycle: config → pool → buys → migration →
  fee claim, all on devnet.
- New `tools/dbc_test.mjs` in the house style — asserts invariants, not price-dependent
  numbers: fees claimed equal fees distributed plus remainder; the split matches the stored
  bps; a replayed claim does not double-pay; a pool with no accrued fee is a no-op.
- Existing suites must stay green throughout: `engine_test`, `adversarial_test`,
  `social_test`, `reward_mode_test`, `qa_sweep`, `dex_test`, `social_http_test`.
- Verify a devnet DBC launch actually appears on DexScreener before calling W1 done — that
  is the entire point and it is the one thing that cannot be asserted locally.

---

## 9. Open questions for the team

1. **Vault strategy** — `bid`, `both` or `lock` (see W6). `bid` is implemented as the
   default; the other two exist behind `VAULT_STRATEGY`. This is the one decision that
   changes what the vault *is*, so it should be made deliberately.
2. **Pool fee rate** — what single base fee, and how is it divided? Today's defaults are
   2% holders / 0.5% REX; that has to become one number plus a split.
3. **Existing two coins** — leave on the old curve, or migrate?
4. **Fee scheduler** — DBC supports a decaying fee (high at open, settling lower). REX
   already has an anti-snipe decaying fee; use DBC's instead of ours?
