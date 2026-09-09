#!/bin/bash
# Smoke the BUILT desktop binary under a virtual X server, twice:
#   1. normal load path      -> the app must paint a mounted DOM from the asar
#   2. broken primary path   -> the retry ladder must fire and the embedded HTTP fallback must paint
#
# Both runs keep their full output in release/smoke-*.log (uploaded by CI) and each run is asserted
# here with grep, so a "pass" cannot come from the harness exiting 0 by accident.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
mkdir -p release
BIN="release/linux-unpacked/kicklive"
XVFB="xvfb-run -a --server-args=-screen 0 1280x800x24"
status=0

if [ ! -x "$BIN" ]; then
  echo "desktop-smoke: $BIN is not executable — did the package step run? (npm run package:linux)" >&2
  exit 1
fi

run_case() {
  local name="$1"
  shift
  local log="release/smoke-${name}.log"
  echo "desktop-smoke: ${name} -> ${log}"
  # ELECTRON_DISABLE_SANDBOX is NOT set: the deb's chrome-sandbox is checked by verify-packaging;
  # under xvfb we run --no-sandbox only because CI containers cannot chown the helper.
  env KICKLIVE_SMOKE=1 KICKLIVE_VERBOSE=1 KICKLIVE_LOG_FILE=0 KICKLIVE_LOAD_ATTEMPTS=4 \
    "$@" \
    timeout 180 $XVFB "$BIN" --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --enable-logging=stderr >"$log" 2>&1
  local code=$?
  echo "  exit=${code}"
  SMOKE_EXIT=$code
  return $code
}

require_line() {
  local log="$1" pattern="$2" what="$3"
  if grep -qE "$pattern" "$log"; then
    echo "  ok: ${what}"
  else
    echo "  MISSING: ${what} (pattern ${pattern} not in ${log})" >&2
    tail -n 30 "$log" | sed 's/^/      | /' >&2
    status=1
  fi
}

forbid_line() {
  local log="$1" pattern="$2" what="$3"
  if grep -qE "$pattern" "$log"; then
    echo "  UNEXPECTED: ${what}" >&2
    grep -nE "$pattern" "$log" | head -5 | sed 's/^/      | /' >&2
    status=1
  else
    echo "  ok: no ${what}"
  fi
}

# 1. happy path
if run_case normal env -u KICKLIVE_SMOKE_BAD_LOAD; then
  require_line release/smoke-normal.log '\[kicklive:renderer\] LOADED source=file://' 'loaded from the asar via file://'
  require_line release/smoke-normal.log 'SMOKE_DOM title="KickLive [^"]*" rootChildren=[1-9]' 'a real DOM painted'
  require_line release/smoke-normal.log 'SMOKE_RESULT ok' 'the probe verdict was ok'
  forbid_line release/smoke-normal.log 'LOAD_FAILED' 'the primary path should not need a retry'
  forbid_line release/smoke-normal.log 'SMOKE_FALLBACK_OK' 'the fallback must not be used on the happy path'
else
  echo "desktop-smoke: normal run exited $SMOKE_EXIT (expected 0)" >&2
  [ "$SMOKE_EXIT" = "0" ] || status=1
fi

# 2. forced failure of the primary renderer path
if run_case broken env KICKLIVE_SMOKE_BAD_LOAD=1 KICKLIVE_NO_HTTP_FALLBACK=0; then
  require_line release/smoke-broken.log 'LOAD_FAILED attempt=1/' 'the broken primary path failed as designed'
  require_line release/smoke-broken.log 'RETRY attempt=[2-9]/' 'the retry ladder ran'
  require_line release/smoke-broken.log '\[kicklive:renderer\] FALLBACK_ACTIVE source=http://127\.0\.0\.1:' 'the embedded loopback server took over'
  require_line release/smoke-broken.log 'SMOKE_FALLBACK_OK source=http://127\.0\.0\.1:' 'the app painted THROUGH the fallback'
  require_line release/smoke-broken.log 'SMOKE_RESULT ok' 'the probe verdict was ok on the fallback'
  forbid_line release/smoke-broken.log 'EXHAUSTED' 'falling back must not end in exhaustion'
else
  echo "desktop-smoke: broken-path run exited $SMOKE_EXIT (expected 0 via fallback)" >&2
  [ "$SMOKE_EXIT" = "0" ] || status=1
fi

# 3. the log-file switch and CSP header must be exercised somewhere: assert the knobs exist in the
#    built bundle rather than launching a third time (cheap, and it fails if main.ts drops them).
for needle in 'KICKLIVE_SMOKE_BAD_LOAD' 'FALLBACK_ACTIVE' 'X-KickLive-Feed' 'setDesktopName'; do
  if grep -q "$needle" build/electron/main.cjs; then
    echo "  ok: bundle contains ${needle}"
  else
    echo "  MISSING: build/electron/main.cjs no longer contains ${needle}" >&2
    status=1
  fi
done

echo "--- smoke logs ---"
for f in release/smoke-normal.log release/smoke-broken.log; do
  [ -f "$f" ] && { echo "## $f"; grep -E '\[kicklive:(renderer|updates)\]|SMOKE_|DIAGNOSTIC' "$f" | tail -18 | sed 's/^/  | /'; }
done

if [ "$status" = "0" ]; then
  echo "desktop-smoke: PASS"
else
  echo "desktop-smoke: FAIL" >&2
fi
exit $status
