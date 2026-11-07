#!/usr/bin/env bash
# Upgrade the rexpad program on mainnet, then grow the launches that the new layout needs.
#
# ⛔ THE SECOND HALF IS NOT OPTIONAL. Three new fields take a Launch from 302 to 350 bytes, and
# Anchor fails Borsh outright on a short account — so between the upgrade landing and
# migrate_launches finishing, those launches cannot be traded. This script does both, in order, and
# refuses to start unless it can finish: there is no state worse than upgrading and then discovering
# there is not enough SOL left to migrate.
#
#   scripts/deploy_onchain.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PROG=2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E
SO=onchain/target/deploy/rexpad.so
RPC=${RPC_URL:-https://api.mainnet-beta.solana.com}
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m⛔ %s\033[0m\n' "$*" >&2; exit 1; }

say "1/6  the artifact"
[ -f "$SO" ] || die "$SO is missing — run: cd onchain && anchor build --ignore-keys"
SIZE=$(stat -f%z "$SO" 2>/dev/null || stat -c%s "$SO")
DIGEST=$(shasum -a 256 "$SO" | cut -d' ' -f1)
echo "     $SIZE bytes, sha256 ${DIGEST:0:16}…"
grep -q "$DIGEST" onchain/BUILD.md || die "that digest is not the one recorded in onchain/BUILD.md — rebuild or update the record before shipping"
echo "     ✅ matches the digest recorded in BUILD.md"

say "2/6  the program id compiled in"
# ⛔ Two declare_id!s sit behind a `devnet` feature. Deploying one built for the devnet id would
# brick the program: Anchor rejects every instruction when the declared id is not its own address.
node -e '
const {PublicKey}=require("@solana/web3.js"); const fs=require("fs");
const so=fs.readFileSync(process.argv[1]);
const hit=(id)=>so.includes(Buffer.from(new PublicKey(id).toBytes()));
const main=hit("2zdwHaCrsXMaCrP3pa14mKrUogyo7m2UMMtECYJ4QA7E");
const dev =hit("975nsaKdkJYg1Ui5qHWZXDJKKRnYZ5LntNzCBT9nqov5");
if(!main||dev){console.error("  mainnet id present:",main," devnet id present:",dev);process.exit(1)}
console.log("     ✅ mainnet id compiled in, devnet id absent");
' "$SO"

say "3/6  authority and funds"
AUTH=$(solana program show "$PROG" -u "$RPC" | awk "/^Authority:/{print \$2}")
ME=$(solana address)
[ "$AUTH" = "$ME" ] || die "the upgrade authority is $AUTH but this keypair is $ME"
BAL=$(solana balance "$ME" -u "$RPC" | awk '{print $1}')
BUF=$(node -e 'console.log(((process.argv[1]/1e9)).toFixed(4))' "$(solana rent "$SIZE" -u "$RPC" --output json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).rentExemptMinimumLamports)}catch{console.log(3000000000)}})' )")
echo "     authority $ME holds $BAL SOL; the deploy buffer needs about $BUF SOL (refunded after)"
node -e 'process.exit(Number(process.argv[1]) >= Number(process.argv[2]) + 0.05 ? 0 : 1)' "$BAL" "$BUF" \
  || die "not enough SOL. Send about $(node -e 'console.log((Number(process.argv[2]) + 0.1 - Number(process.argv[1])).toFixed(2))' "$BAL" "$BUF") more SOL to $ME and re-run. Nothing has been changed."

say "4/6  room for a larger program"
ALLOC=$(solana account "$(solana program show "$PROG" -u "$RPC" | awk '/^ProgramData/{print $3}')" -u "$RPC" | awk '/^Length:/{print $2}')
NEED=$((SIZE + 45))
if [ "$ALLOC" -lt "$NEED" ]; then
  echo "     extending ProgramData by $((NEED - ALLOC)) bytes"
  solana program extend "$PROG" $((NEED - ALLOC)) -u "$RPC"
else
  echo "     ✅ already allocated $ALLOC bytes, need $NEED"
fi

say "5/6  upgrade"
solana program deploy "$SO" --program-id "$PROG" -u "$RPC"
solana program dump "$PROG" /tmp/deployed-rexpad.so -u "$RPC" >/dev/null
# The dump is padded to the allocation, so compare only the bytes the artifact actually has.
node -e '
const fs=require("fs"),c=require("crypto");
const a=fs.readFileSync(process.argv[1]), b=fs.readFileSync(process.argv[2]).subarray(0,a.length);
const h=(x)=>c.createHash("sha256").update(x).digest("hex");
if(h(a)!==h(b)){console.error("  deployed bytes do not match the artifact");process.exit(1)}
console.log("     ✅ the deployed bytes are the artifact, byte for byte");
' "$SO" /tmp/deployed-rexpad.so

say "6/6  grow the launches the new layout needs"
RPC_URL="$RPC" node onchain/migrate_launches.mjs --send

say "done — upgraded and migrated"
