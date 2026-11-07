#!/usr/bin/env bash
# Deploy REX Chain to Fly, forward-only.
#
# ⛔ THE RULE THIS SCRIPT EXISTS TO ENFORCE: a deploy may only ever move FORWARD. Several sessions
# work this repo at once and any of them may ship while you are mid-task, so the commit you branched
# from is a SNAPSHOT, not a fact — production moves underneath you silently. Cut a branch, work for
# two hours, deploy, and you have reverted everything that shipped in between. Nothing warns you:
# the deploy succeeds and the loss is noticed later by whoever shipped the work you deleted.
#
# So this refuses to deploy a tree that does not already CONTAIN what is running.
#
#   scripts/deploy.sh                 # gate, full suite, deploy, verify
#   SKIP_TESTS=1 scripts/deploy.sh    # gate and verify still run; tests do not
set -euo pipefail
APP="${APP:-rexpad}"
# ⛔ THE SUITE'S PORT IS AN OVERRIDE, NOT A CONSTANT. This machine runs several projects at once and
# 8787 belongs to nobody in particular. On 8 Nov another project's dev server was listening on it
# and this script died with "the test server never came up" — the real cause, EADDRINUSE, was
# visible only in the log. The advice it used to give was "kill it and re-run", which is wrong when
# the process belongs to somebody else's session and they are mid-task.
#   TEST_PORT=8797 scripts/deploy.sh
TEST_PORT="${TEST_PORT:-8787}"
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m⛔ %s\033[0m\n' "$*" >&2; exit 1; }

say "1/5  working tree"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes — commit first, or the image ships code that is in no commit and /version.txt lies about what is running."
HEAD_SHA=$(git rev-parse --short HEAD)
echo "     HEAD is $HEAD_SHA"

say "2/5  forward-only gate"
git fetch --all -q
# The live sha, probed NOW. Never a value read earlier in a session and never one from a note: both
# go stale the moment another session ships.
PROD_RAW=$(curl -s --max-time 15 "https://$APP.fly.dev/version.txt" || true)
PROD=$(printf '%s' "$PROD_RAW" | head -1 | sed 's/.*-//' | tr -d '[:space:]')
if [ -n "$PROD" ] && git cat-file -e "$PROD^{commit}" 2>/dev/null; then
  if git merge-base --is-ancestor "$PROD" HEAD; then
    echo "     ✅ live $PROD is an ancestor of HEAD — this deploy can only add"
  else
    echo "     live      : $PROD"
    echo "     your HEAD : $HEAD_SHA"
    die "this would ROLL BACK production. Do not force it — a conflict here is the gate working.
    Move forward onto what is live instead:  git rebase $PROD   (or merge it in)
    then re-run the FULL suite on the rebased tree and run this script again."
  fi
else
  # Bootstrap, and the one case where the sha cannot be read: an older image that predates
  # /version.txt, or an app that is down. Fall back to the strongest remaining check and SAY SO.
  echo "     ⚠️  $APP did not report a usable sha (got: '${PROD:-nothing}')."
  echo "        Falling back to origin/main, which is weaker: it catches a stale branch but NOT a"
  echo "        session that deployed without pushing."
  git merge-base --is-ancestor origin/main HEAD \
    || die "origin/main has commits HEAD does not. Rebase onto it before deploying."
  echo "     ✅ origin/main is an ancestor of HEAD"
fi

say "3/5  full suite"
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  echo "     skipped by SKIP_TESTS=1"
else
  # ⛔ Green must be green on the tree being SHIPPED. A pass from before a rebase proves nothing,
  # because the rebase changed what you are shipping.
  # ⛔ Capture the PID. `pkill -f "PORT=8787"` cannot work: an env-var prefix is not part of the
  # process command line, so it matches nothing, the old server keeps the port, and the suite then
  # tests a BUILD FROM BEFORE YOUR CHANGES while reporting green. That is exactly how a stale
  # server once made a new route look broken when it was fine.
  # ⛔ REFUSE A PORT THAT IS ALREADY TAKEN, AND SAY WHAT HOLDS IT. Starting anyway means the server
  # exits on EADDRINUSE and every HTTP check in the suite then runs against WHATEVER is listening —
  # another project, serving another app, answering 404 to everything.
  if lsof -nP -iTCP:"$TEST_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    HOLDER=$(lsof -nP -iTCP:"$TEST_PORT" -sTCP:LISTEN | awk 'NR==2{print $1" (pid "$2")"}')
    die "port $TEST_PORT is already in use by $HOLDER.
    If it is yours, stop it. If it belongs to another session, do NOT kill it — use another port:
      TEST_PORT=8797 scripts/deploy.sh"
  fi
  SIM=1 PORT="$TEST_PORT" LAUNCH_HOLD_USD=0 DATA_DIR=/tmp/rexdeploy GIT_SHA="$HEAD_SHA" node server.mjs >/tmp/rexdeploy.log 2>&1 &
  SRV=$!
  trap 'kill "$SRV" 2>/dev/null || true' EXIT
  for _ in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:$TEST_PORT/api/state && break; sleep 1; done
  curl -sf -o /dev/null http://127.0.0.1:$TEST_PORT/api/state || die "the test server never came up — see /tmp/rexdeploy.log. Running the suite without it reports unreachable HTTP checks as passes."
  # And prove the port is serving THIS tree, not something left running from an earlier attempt.
  SERVING=$(curl -s http://127.0.0.1:$TEST_PORT/version.txt | head -1 | sed 's/.*-//' | tr -d '[:space:]')
  [ "$SERVING" = "$HEAD_SHA" ] || die "port $TEST_PORT is serving $SERVING, not $HEAD_SHA — a stale server is holding the port and the suite would test the wrong build. Kill it and re-run."
  BAD=""; SKIPPED=""
  for t in tools/*_test.mjs; do
    # ⛔ Both argv and BASE: build_surface_test and security_test read only process.argv[2], so a
    # BASE-only invocation sends them at their hardcoded default and they fail on a refused connection.
    #
    # ⛔ ONE FILE PER SUITE. Every run used to write /tmp/rextest.out, so the suite after a failing
    # one destroyed its output about 200ms later and the only evidence left was the name.
    OUT="/tmp/rextest-$(basename "$t" .mjs).out"
    BASE=http://127.0.0.1:$TEST_PORT node "$t" http://127.0.0.1:$TEST_PORT >"$OUT" 2>&1 || BAD="$BAD $(basename "$t")"
    # ⛔ A SUITE CAN EXIT 0 HAVING NOT RUN A CHECK. security_test skips its Jupiter checks when
    # Jupiter is unreachable — deliberately, so a third party being down cannot block a deploy of
    # unrelated code, since the alternative is pressure to weaken the test in order to ship. But
    # "could not verify the fee-injection defences" must never LOOK like "verified them": exit 0
    # plus a clobbered file made those two outcomes byte-identical here.
    #
    # Matched against the summary line's own count, not against the prose of the warning: that
    # count is a contract the harness prints on every run ("0 skipped" in the normal case), whereas
    # grepping a sentence means a later reword silently turns this check off — and it would fail
    # open, which is the wrong direction for the one check that reports unverified security.
    grep -qE '[1-9][0-9]* skipped' "$OUT" && SKIPPED="$SKIPPED $(basename "$t")"
    # ⛔ AND THE CASE WHERE THE CHECK ABOVE ITSELF FAILED OPEN. The pattern is matched against the
    # summary line's format, so a later reword — "2 skipped" becoming "skipped: 2" — would make it
    # find nothing and go quiet, and quiet is indistinguishable from "nothing was skipped". This
    # fires only on the exact mismatch of a suite that PRINTED a skip while no count parsed, so the
    # 62 suites that never skip stay silent and this is not a blanket demand for a summary line.
    if grep -q 'SKIPPED' "$OUT" && ! grep -qE '[0-9]+ skipped' "$OUT"; then
      SKIPPED="$SKIPPED $(basename "$t")"
      echo "     ⚠️  $(basename "$t") printed a skip but no parsable count — the summary format has drifted and the skip check above went blind"
    fi
  done
  kill "$SRV" 2>/dev/null || true; trap - EXIT
  [ -z "$BAD" ] || die "failing suites:$BAD"
  if [ -n "$SKIPPED" ]; then
    printf '\033[33m     ⚠️  CHECKS WERE SKIPPED, NOT PASSED, in:%s\033[0m\n' "$SKIPPED"
    for s in $SKIPPED; do sed -n 's/^/        /p' "/tmp/rextest-${s%.mjs}.out" | grep -E 'SKIPPED|could not run'; done
    echo "        Shipping anyway — a dependency being down is not a regression here — but this deploy"
    echo "        has NOT verified the checks above. Re-run the suite once it is back."
  fi
  echo "     ✅ every suite exited 0"
fi

say "4/5  deploy"
flyctl deploy -a "$APP" --build-arg "GIT_SHA=$HEAD_SHA"

say "5/5  verify"
# A deploy is not done until the shipped sha is PUSHED. /version.txt reports what is running and
# cannot tell you the commit exists only on this machine.
git push origin HEAD
git ls-remote --heads origin | grep -q "$(git rev-parse HEAD)" \
  && echo "     ✅ $HEAD_SHA is on origin" \
  || die "$HEAD_SHA is NOT on origin — it exists only on this machine and the next session will roll it back."
for _ in $(seq 1 20); do
  LIVE=$(curl -s --max-time 10 "https://$APP.fly.dev/version.txt" | head -1 | sed 's/.*-//' | tr -d '[:space:]')
  [ "$LIVE" = "$HEAD_SHA" ] && break; sleep 3
done
[ "$LIVE" = "$HEAD_SHA" ] && echo "     ✅ live is now $LIVE" || die "live reports '$LIVE', expected $HEAD_SHA."
say "done — $APP is running $HEAD_SHA"
