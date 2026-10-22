#!/usr/bin/env bash
# Runs the built action (dist/index.mjs) against a real Community Edition stack.
# Usage: test/e2e/run.sh   (DJANGO_VERSION, NGINX_VERSION and DD_PORT may be set)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
port="${DD_PORT:-18080}"
url="http://127.0.0.1:$port"
compose=(docker compose -p dd-action-e2e -f "$here/compose.yml")
work="$(mktemp -d)"

cleanup() {
  if [ "${KEEP_STACK:-}" != "1" ]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

"${compose[@]}" up -d --quiet-pull
echo "Waiting for DefectDojo at $url"
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url/api/v2/" || true)
  # Any answer from the API (it refuses anonymous requests with 401 or 403) means it is up.
  case "$code" in 200|401|403) break ;; esac
  sleep 5
done
case "${code:-}" in 200|401|403) ;; *) "${compose[@]}" logs --tail 80 uwsgi initializer; fail "DefectDojo did not come up" ;; esac

token=$("${compose[@]}" exec -T uwsgi python manage.py shell -c \
  "from django.contrib.auth.models import User; from rest_framework.authtoken.models import Token; print(Token.objects.get_or_create(user=User.objects.get(username='admin'))[0].key)" 2>/dev/null | tail -1)
[ -n "$token" ] || fail "could not create an API token"

# Runs the action like the runner does; prints outputs as name=value lines.
action() {
  local out="$work/output" summary="$work/summary.md"
  : > "$out"; : > "$summary"
  local status=0
  env -i PATH="$PATH" HOME="$HOME" \
    GITHUB_OUTPUT="$out" GITHUB_STEP_SUMMARY="$summary" \
    GITHUB_REPOSITORY="acme/e2e-app" GITHUB_REF_NAME="main" GITHUB_SHA="e2e0000" GITHUB_RUN_ID="1" GITHUB_SERVER_URL="https://github.com" \
    INPUT_DEFECTDOJO-URL="$url" INPUT_API-TOKEN="$token" \
    INPUT_REIMPORT=true INPUT_AUTO-CREATE-CONTEXT=true INPUT_MINIMUM-SEVERITY=Info INPUT_FAIL-ON=none INPUT_TIMEOUT-MINUTES=10 INPUT_STRICT=false \
    "$@" node "$root/dist/index.mjs" > "$work/log" 2>&1 || status=$?
  cat "$work/log" >&2
  # GITHUB_OUTPUT holds name<<delimiter / value / delimiter blocks.
  awk '/<</{split($0,a,"<<"); name=a[1]; getline; print name"="$0}' "$out"
  echo "exit=$status"
}

value() { grep "^$1=" <<<"$2" | head -1 | cut -d= -f2-; }

echo "== 1. First import creates three findings"
r=$(action INPUT_FILE="$here/first.sarif" INPUT_SCAN-TYPE=SARIF INPUT_PUSH-TO-CONNECTOR=true)
[ "$(value exit "$r")" = "0" ] || fail "first import failed"
[ "$(value edition "$r")" = "community" ] || fail "edition was $(value edition "$r")"
[ "$(value active "$r")" = "3" ] || fail "expected 3 active, got $(value active "$r")"
[ "$(value created "$r")" = "3" ] || fail "expected 3 created, got $(value created "$r")"
test_id=$(value test-id "$r")
grep -q "What DefectDojo Pro adds" "$work/summary.md" || fail "summary has no Pro section"
grep -q "push-to-connector is a DefectDojo Pro feature" "$work/log" || fail "no Pro warning"

echo "== 2. Reimport without the high finding closes it in the same test"
r=$(action INPUT_FILE="$here/second.sarif" INPUT_SCAN-TYPE=SARIF)
[ "$(value exit "$r")" = "0" ] || fail "reimport failed"
[ "$(value test-id "$r")" = "$test_id" ] || fail "reimport went to test $(value test-id "$r"), not $test_id"
[ "$(value closed "$r")" = "1" ] || fail "expected 1 closed, got $(value closed "$r")"
[ "$(value active "$r")" = "2" ] || fail "expected 2 active, got $(value active "$r")"
[ "$(value active-high "$r")" = "0" ] || fail "the high finding is still active"

echo "== 3. fail-on critical fails the step"
r=$(action INPUT_FILE="$here/second.sarif" INPUT_SCAN-TYPE=SARIF INPUT_FAIL-ON=critical)
[ "$(value exit "$r")" = "1" ] || fail "expected exit 1 from the gate"
grep -q "1 active finding at Critical or above" "$work/log" || fail "gate message missing"

echo "== 4. A bad scan type gives a readable error"
r=$(action INPUT_FILE="$here/second.sarif" INPUT_SCAN-TYPE="Not A Scanner")
[ "$(value exit "$r")" = "1" ] || fail "expected exit 1 for a bad scan type"
grep -q "HTTP 400 while reimporting the report. scan_type:" "$work/log" || fail "error message not flattened"

echo "== 5. strict refuses a Pro-only input on Community Edition"
r=$(action INPUT_FILE="$here/second.sarif" INPUT_SCAN-TYPE=SARIF INPUT_BACKGROUND-IMPORT=true INPUT_STRICT=true)
[ "$(value exit "$r")" = "1" ] || fail "expected strict to fail"

echo "PASS: all end-to-end checks"
