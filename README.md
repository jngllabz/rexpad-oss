# REX Chain — No first bite. Paid to hold.

The $REX launchpad: every coin is quoted in **$REX** (`CmQJNJ185pjzQoebPbcqZu1kTykHxJbn4gER1Af7pump`), so the
pad's volume is REX demand and every holder payout is paid in REX. Skinned to the rex.fun IP — glyph, mascot,
palette (`#0b100c` ink / `#22c55e` / `#9dff8f`), Clash Display + Inter + JetBrains Mono — and it reuses rex.fun's
own access model: **hold $500 of $REX to launch**, a wallet balance check, never a payment.

## The two USPs

**1. Fair Open — sealed, uniform-price launches.**
Every launch opens with a sealed window (30 s – 5 min, creator's choice). Commitments are escrowed;
at the bell they clear as *one* buy on the curve and are allocated pro-rata, so every bidder — the
dev's own buy included — pays exactly the same price. There is no ordering inside the window, so
there is nothing for a block-0 sniper to snipe. (`lib/engine.mjs: settleFairOpen`)

**2. Hold to evolve — holder rewards weighted by hold time, on a countdown.**
StonkFun's reward mode pays holders pro-rata by balance whenever a pot fills, with no schedule.
FORGE pays every epoch (visible countdown), and each holder's share = balance × multiplier, where
the multiplier climbs ×1 → ×1.25 → ×1.5 → ×2 → ×3 over 1 h / 6 h / 24 h / 72 h of *unbroken* holding.
Any sell resets the clock. After graduation the AMM's 0.25 % fee flows into the same pool (LP is burned,
so the fee belongs to holders). (`lib/engine.mjs: convictionOf, runEpoch`)

## Everything else that's on par or better than StonkFun
- Quote assets: **$REX** (default) / SOL / USDC / $GP — add any in `lib/prices.mjs`.
- Raydium-LaunchLab-compatible curve sizing: 793.1 M of 1 B on the curve, raise "worth 85 SOL" in
  the chosen quote, price-continuous migration of the raise + 206.9 M into a burned-LP AMM.
- No launch fee. 1 % platform fee on curve trades, 0.25 % on the AMM (→ holder pool).
- Live everything over WebSocket: trades, candles, Fair Open totals, epochs, chat, new launches.
- TradingView-grade candles (lightweight-charts), MCap-USD / price-in-quote toggle, 1m–1h timeframes.
- King of the Hill, trending / new / graduating / most-paid sorts, quote filters, search (`/`).
- Per-wallet portfolio with PnL, conviction tier per position, yield earned, Fair Open commitments.
- Leaderboards: most paid to holders, top earners, diamond hands, top creators.
- Wallet sign-in by message signature (Phantom / Backpack / Solflare) — no transaction, no gas.

## Run
```bash
npm install
npm run dev        # SIM=1: market seeded with REAL coins from StonkFun's public API (names, tickers, PFPs, links,
                   #        creators, live market caps), bot activity, demo wallets, 2-min epochs, fast conviction clock
npm test           # 34 deterministic engine checks (curve math, graduation continuity, Fair Open, epochs, adversarial edges)
node tools/api_fuzz.mjs   # 243 hostile requests against a running server — must be 0 failures
```
Production: `node server.mjs` with `DATA_DIR`, `PORT`, optional `EPOCH_MS`. `SIM` unset = clean ledger,
no bots, no demo wallets, no StonkFun seed. The seed (`lib/stonkfun.mjs`) pulls the biggest graduated + biggest
bonding coins per quote, caches their PFPs under `data/img/`, lands graduated coins on their live market cap, and
feeds the live Fair Open rail from `sort=newest` so every launch you see is a real one. Deploy: `flyctl launch --copy-config` then `flyctl deploy`.

## Status
The whole product runs on the FORGE engine (`lib/engine.mjs`) with real wallet authentication.
Balances are a paper ledger with a faucet so every mechanic can be exercised end-to-end today.
The on-chain settlement program (Anchor: curve vault, Fair Open escrow PDA, conviction-weighted
distributor) is the next milestone and slots in behind the same API.

## On-chain mode

The whole product runs against the REX Chain Anchor program in `onchain/` — no paper ledger, no bots.
The server builds unsigned transactions, the user's wallet signs them, the server relays; it holds
no user key. It runs only two operations itself: ringing the Fair Open bell (permissionless) and
posting the reward merkle root (config authority).

```bash
solana-test-validator -r
solana program deploy --url localhost --program-id onchain/target/deploy/rexpad-keypair.json onchain/target/deploy/rexpad.so
RPC_URL=http://127.0.0.1:8899 CRANK_KEY=<base58> node server.mjs
```

| env | meaning |
|---|---|
| `RPC_URL` | turns on-chain mode on |
| `CRANK_KEY` | base58 secret for the settle + epoch cranks |
| `MIN_EPOCH_USD` | pots below this roll into the next epoch (default 0.05) |
| `DEV_QUOTE_MINT` | point the $REX quote at a mint that exists on a test cluster |

### Test suites
```bash
npm test                        # engine (demo mode)
node onchain/tests/e2e.mjs      # 25 — the program itself
node tools/chain_e2e.mjs        # 19 — server-built, wallet-signed lifecycle
BASE=… node tools/site_e2e.mjs <quoteMint> <mintAuthSecret>   # 13 — the whole site on-chain
node tools/api_fuzz.mjs <base>  # 243 hostile requests
```
The two program-level suites share one deterministic authority so they can run against the same
validator; start it with `-r` for a clean pass.
