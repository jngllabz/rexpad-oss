# REX Chain on-chain program

Anchor program implementing the two REX Chain mechanics with no custodian:

| Instruction | What it does |
|---|---|
| `init_config` / `set_config` | platform fee wallet, curve fee (1%), AMM fee (0.25%), pause |
| `create_launch` | mints a fixed 1B supply into the program vault and **permanently revokes mint authority**; sizes the curve (793.1M sold, virtual reserves) |
| `commit` / `withdraw_commit` | Fair Open escrow — quote is held by the program, withdrawable until the bell |
| `settle_fair_open` | **permissionless**; performs ONE aggregate buy so every bidder clears at a single uniform price |
| `claim_fair_open` | pro-rata allocation + pro-rata refund of any over-fill; opens the conviction clock |
| `buy` / `sell` | constant-product trading on the curve, then on the locked AMM. **Any sell zeroes `Position.held_since`.** |
| `post_epoch` | crank posts a merkle root of conviction-weighted shares and locks the pot |
| `claim_reward` | sha256 merkle proof → payout; one `ClaimReceipt` PDA per (epoch, wallet) makes double-claims impossible |

Liquidity is never withdrawable: at graduation the raise plus the reserved 206.9M LP tokens become
the AMM reserves inside the program's own vaults, and no instruction can drain them.

## Build & test
```bash
cargo build-sbf --manifest-path programs/rexpad/Cargo.toml   # or: anchor build (also emits the IDL)
solana-test-validator -r                                      # separate shell
solana program deploy --url localhost --program-id target/deploy/rexpad-keypair.json target/deploy/rexpad.so
node tests/e2e.mjs                                            # 25 end-to-end checks
```

## Deployed

| cluster | program | status |
|---|---|---|
| **devnet** | `77pK6gygAzFfHVG2fAv2yizwA5tNipGZAA7TURoBEe6s` | live, 19/19 lifecycle proven on chain |
| mainnet | — | not deployed (needs ~2.3 SOL + an audit) |

A full lifecycle ran on devnet: launch `86LVfPs4d7YP5v4mNVuoo2gQGXsezwqXnd4RzYN4Tgqh` — three
sealed commitments cleared at one uniform price, the conviction clock reset on a sell, and reward
epoch #0 paid 158.51 of a 202.5 pot against a merkle root.

Run the suite against devnet (the faucet is usually rate-limited, so fund from a wallet you hold):
```bash
RPC_URL=https://api.devnet.solana.com FUNDER=~/.config/solana/id.json CRANK_IS_FUNDER=1 \
  FUND_SOL=0.06 FAIR_OPEN_SECS=120 node tools/chain_e2e.mjs
```

## Status
Builds, deploys and passes 25 end-to-end checks on a local validator, covering the uniform-price
property, escrow custody, permissionless settlement, the conviction clock, graduation, LP lock and
merkle reward claims (including double-claim and non-member rejection).

**Not yet audited.** Do not put real money through this program until a third-party audit is done.
Mainnet deployment also needs ~3-5 SOL for the program account and an upgrade-authority decision
(keep for patching vs. burn for immutability).

## Running REX Chain against the program

```bash
# 1. program
solana-test-validator -r                                   # or a real cluster
solana program deploy --url localhost --program-id onchain/target/deploy/rexpad-keypair.json onchain/target/deploy/rexpad.so

# 2. site in on-chain mode (no paper ledger, no bots)
RPC_URL=http://127.0.0.1:8899 CRANK_KEY=<base58 secret> node server.mjs

# 3. prove the whole path (server builds -> wallet signs -> chain executes)
RPC_URL=http://127.0.0.1:8899 node tools/chain_e2e.mjs      # 19 checks, idempotent
```

`CRANK_KEY` signs only the two operations that aren't a user's: ringing the Fair Open bell
(permissionless — anyone can call it) and posting the reward merkle root (config authority).
Every user action is built unsigned by the server and signed in the user's own wallet.
