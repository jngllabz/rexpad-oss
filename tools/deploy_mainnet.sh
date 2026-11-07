#!/usr/bin/env bash
# Deploy REX Chain to Solana mainnet-beta.
#
# Read this before running it. Two of the steps below cannot be undone:
#
#   * The program deploy spends real SOL on rent. Recoverable only by closing the program, which
#     permanently bricks the program id for everyone.
#   * GENESIS IS ONE SHOT. `initialize` writes the partner wallet and its basis points into the
#     config account, and there is deliberately no instruction in the program that can lower, clear
#     or redirect them afterwards. Get the numbers wrong and the only fix is a new program id.
#
# The script stops at genesis and makes you type the confirmation yourself. It does NOT point the
# website at mainnet — that is a separate decision with its own trap, documented at the bottom.
set -euo pipefail

CLUSTER=https://api.mainnet-beta.solana.com
KEYPAIR=${KEYPAIR:-$HOME/.config/solana/id.json}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SO="$ROOT/onchain/target/deploy/rexpad.so"
PROGRAM_KP="$ROOT/onchain/target/deploy/rexpad-keypair.json"

PARTNER=${PARTNER_WALLET:-EGB6v3y5oS7Whv4KHYp8ksL2wRfqdfAF5Dbqq8kHXsZH}
PARTNER_BPS=${PARTNER_BPS:-300}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m⛔ %s\033[0m\n' "$*" >&2; exit 1; }

say "1/6  pre-flight"
[ -f "$SO" ] || die "no built binary at $SO — run: cd onchain && anchor build"
[ -f "$PROGRAM_KP" ] || die "no program keypair at $PROGRAM_KP. Without it the program id cannot be claimed, and it is the only thing that can ever upgrade this program. Back it up before going further."

PROGRAM_ID=$(solana address -k "$PROGRAM_KP")
DECLARED=$(grep -oE 'declare_id!\("[^"]+"\)' "$ROOT/onchain/programs/rexpad/src/lib.rs" | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}')
[ "$PROGRAM_ID" = "$DECLARED" ] || die "the keypair ($PROGRAM_ID) is not the id compiled into the program ($DECLARED). Deploying this would put the code at an address it does not believe it lives at, and every PDA it derives would be wrong."

# The cluster is compiled in, not configured: the Raydium CPMM address graduation migrates into is a
# const chosen by a cargo feature. A devnet binary on mainnet would send real liquidity to an address
# that holds nothing there, so this is checked against the bytes rather than against the build command.
grep -aq "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" "$SO" \
  || die "this binary does not carry the MAINNET Raydium CPMM address. Rebuild without --features devnet."
grep -aq "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb" "$SO" \
  && die "this binary carries the DEVNET Raydium CPMM address. It is the wrong build entirely."

solana program show "$PROGRAM_ID" -u "$CLUSTER" >/dev/null 2>&1 \
  && die "$PROGRAM_ID already exists on mainnet. Use 'solana program deploy --program-id' to upgrade it deliberately; this script only does first deploys."

SIZE=$(wc -c < "$SO" | tr -d ' ')
NEED=$(solana rent "$SIZE" -u "$CLUSTER" | grep -oE '[0-9.]+')
HAVE=$(solana balance -k "$KEYPAIR" -u "$CLUSTER" | grep -oE '^[0-9.]+')
printf '    program id   %s\n    size         %s bytes\n    rent needed  %s SOL (+ ~0.03 fees)\n    wallet has   %s SOL\n' \
  "$PROGRAM_ID" "$SIZE" "$NEED" "$HAVE"
awk -v h="$HAVE" -v n="$NEED" 'BEGIN { exit !(h > n + 0.03) }' \
  || die "not enough SOL. Fund $(solana address -k "$KEYPAIR") with the difference and run again."

say "2/6  the full suite, on the tree being shipped"
( cd "$ROOT" && node tools/engine_test.mjs >/dev/null && node tools/adversarial_test.mjs >/dev/null ) \
  || die "tests fail on this tree. Nothing ships red."
echo "    engine + adversarial pass"

say "3/6  deploy the program (real SOL)"
read -r -p "    type DEPLOY to continue: " a; [ "$a" = "DEPLOY" ] || die "stopped."
solana program deploy "$SO" \
  --program-id "$PROGRAM_KP" \
  --keypair "$KEYPAIR" \
  --url "$CLUSTER"

say "4/6  confirm it is live"
solana program show "$PROGRAM_ID" -u "$CLUSTER"

say "5/6  GENESIS — this cannot be undone"
cat <<EOF
    partner wallet : $PARTNER
    partner share  : $PARTNER_BPS bps  ($(awk -v b="$PARTNER_BPS" 'BEGIN{printf "%.2f", b/100}')% of protocol income)

    Check the wallet character by character. No instruction in this program can change it afterwards.
EOF
read -r -p "    type GENESIS to write it: " b; [ "$b" = "GENESIS" ] || die "stopped before genesis. The program is deployed but uninitialized; re-run this step when ready."
( cd "$ROOT" && RPC_URL="$CLUSTER" PARTNER_WALLET="$PARTNER" PARTNER_BPS="$PARTNER_BPS" node tools/set-share.mjs )

say "6/6  read the config back off chain"
( cd "$ROOT" && RPC_URL="$CLUSTER" node -e '
  const CH = await import("./lib/chain.mjs");
  const c = await CH.configAccount();
  console.log("   authority :", c.authority);
  console.log("   partner   :", c.partner, c.partnerBps, "bps");
  console.log("   paused    :", c.paused);
' --input-type=module )

cat <<'EOF'

Done — the PROGRAM is on mainnet. The SITE is not, and that is deliberate.

rexpad.fly.dev still points at devnet, and flipping it is not just RPC_URL. Three things have to
move together or the site will lie about what people are looking at:

  DB_NAME       devnet.sqlite holds nine devnet launches. Point mainnet at it and those coins
                appear as real ones, with real-looking charts. Mainnet needs its OWN database.
  FAUCET_MINT   must be UNSET. A faucet on mainnet hands out free tokens against real liquidity.
  DEV_QUOTE_MINT must be UNSET, so the quote table resolves to the real mainnet mints again —
                which is also what un-greys the META / ALTS / Stocks tabs.

  flyctl secrets unset FAUCET_MINT FAUCET_AMOUNT FAUCET_SOL DEV_QUOTE_MINT -a rexpad
  flyctl secrets set RPC_URL=<a paid mainnet RPC> -a rexpad
  # then set DB_NAME=mainnet.sqlite in fly.toml and deploy

Use a paid RPC. The public mainnet endpoint rate-limits hard enough to lose trades, and the
indexer's completeness cursor will simply stop advancing rather than report a gap it cannot fill.
EOF
