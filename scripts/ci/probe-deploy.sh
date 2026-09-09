#!/bin/bash
# Post-deploy probe for the web surface: proves the *deployed* host keeps the same contract as
# server/static-server.ts. The failure this catches is real and common: a platform-level SPA rewrite
# that swallows /assets/*.js and answers a 404 with index.html + 200.
#
#   bash scripts/ci/probe-deploy.sh https://kicklive.vercel.app
set -uo pipefail

url="${1:-}"
if [ -z "$url" ]; then
  echo "probe-deploy: usage: $0 <deployed-url>" >&2
  exit 2
fi
url="${url%/}"
status=0
note() { echo "  $*"; }
fail() {
  echo "  FAIL: $*" >&2
  status=1
}

# The build must exist locally to know the hashed asset names (CI keeps dist/web from the build job).
index=$(curl -fsS "$url/" 2>/dev/null) || {
  fail "GET $url/ failed"
  exit 1
}
echo "probe-deploy: $url"
echo "$index" | head -c 200 >/dev/null || fail "empty index.html"

ctype=$(curl -sSI "$url/" | tr -d '\r' | awk 'tolower($1)=="content-type:"{sub($1 FS,"");print;exit}')
case "$ctype" in text/html*) note "ok: / is text/html ($ctype)" ;; *) fail "/ served as '$ctype' (expected text/html)" ;; esac

asset=$(printf '%s' "$index" | grep -o 'assets/[A-Za-z0-9._-]*\.js' | head -1)
if [ -n "$asset" ]; then
  actype=$(curl -sSI "$url/$asset" | tr -d '\r' | awk 'tolower($1)=="content-type:"{sub($1 FS,"");print;exit}')
  acode=$(curl -sS -o /dev/null -w '%{http_code}' "$url/$asset")
  [ "$acode" = "200" ] || fail "$asset returned $acode"
  case "$acctype" in
  text/javascript*) note "ok: /$asset is $acctype" ;;
  *) fail "$asset is '$acctype' — browsers refuse ES modules without a JS MIME type" ;;
  esac
else
  note "note: no hashed asset reference found in the served HTML (inline build?)"
fi

missing_code=$(curl -sS -o /tmp/missing.out -w '%{http_code}' "$url/assets/kicklive-does-not-exist-00000000.js")
[ "$missing_code" = "404" ] || fail "a missing asset returned $missing_code instead of 404 (a blanket SPA rewrite swallows asset 404s)"
if [ "$missing_code" = "200" ] && grep -qi '<!doctype html' /tmp/missing.out; then
  fail "missing asset returned the HTML shell: the PWA will cache a broken page forever"
fi

route_code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'accept: text/html' "$url/admin/matches")
[ "$route_code" = "200" ] || fail "client-side route /admin/matches returned $route_code (expected the app shell)"

sw_code=$(curl -sS -o /dev/null -w '%{http_code}' "$url/sw.js")
[ "$sw_code" = "200" ] || fail "/sw.js returned $sw_code (the PWA cannot update without it)"

for traversal in "/../etc/passwd" "/%2e%2e/%2e%2e/etc/passwd"; do
  body=$(curl -sS --path-as-is "$url$traversal" 2>/dev/null | head -c 400)
  case "$body" in *root:*) fail "$traversal returned file contents" ;; *) note "ok: $traversal refused/normalised" ;; esac
done

[ "$status" = "0" ] && echo "probe-deploy: PASS" || echo "probe-deploy: FAIL" >&2
exit $status
