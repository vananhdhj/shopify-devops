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

# A real Checkout through the storefront, as a browser would do it, then wait for the worker to
# settle the Order. Uses the seed product "Notebook Set" (Stock 60, reset by the dev seed job).
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT
curl -fsS --max-time 10 -c "$jar" -b "$jar" -o /dev/null -X POST \
  --data "productId=00000000-0000-4000-8000-000000000007&action=add" "$base/cart/items" || fail "add to cart"
key="$(curl -fsS --max-time 10 -b "$jar" "$base/checkout" | sed -nE 's/.*name="checkoutKey" value="([^"]+)".*/\1/p' | sed -n 1p)"
[ -n "$key" ] || fail "checkout form had no checkout key"
order="$(curl -fsS --max-time 10 -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' -X POST \
  --data "checkoutKey=${key}&paymentScenario=approve" "$base/orders")"
[[ "$order" == */orders/* ]] || fail "checkout did not lead to an Order page (got '$order')"

status=""
for _ in $(seq 1 30); do
  status="$(curl -fsS --max-time 10 "$order" | sed -nE 's/.*Status: (<!-- -->)?([A-Za-z]+).*/\2/p' | sed -n 1p)"
  [ "$status" = "Confirmed" ] && break
  sleep 1
done
[ "$status" = "Confirmed" ] || fail "Order not Confirmed after 30 s (last status: ${status:-unknown})"

echo "smoke: OK - $base serves the seeded catalog and a Checkout was Confirmed"
