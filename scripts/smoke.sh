#!/usr/bin/env bash
# Smoke test of a deployed environment through its ingress, from the operator's machine.
# Reports success only when every check passes.
set -euo pipefail

base="${SHOP_URL:-http://shop.localhost:8080}"
fail() { echo "smoke: FAIL - $*" >&2; exit 1; }

curl -fsS --max-time 10 "$base/healthz" | grep -q '"ok"' || fail "storefront health check at $base/healthz"
page="$(curl -fsS --max-time 10 "$base/")" || fail "storefront home page at $base/"
for product in "Last Lantern" "Canvas Tote"; do
  grep -q "$product" <<<"$page" || fail "seeded product '$product' not on the home page"
done
echo "smoke: OK - $base serves the seeded catalog"
