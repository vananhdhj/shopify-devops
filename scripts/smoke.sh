#!/usr/bin/env bash
# Smoke test of a deployed environment through its ingress, from the operator's machine.
# Reports success only when every check passes.
#
# Modes for the bad-release drill (ShopServerErrorRatioHigh, read at the in-cluster alert catcher):
#   check    (default) the storefront serves the catalog and a Checkout is Confirmed
#   fault    with the fault release live: one Checkout attempt a second until the alert fires
#   recover  after the revert: a Checkout every 5 s until the alert resolves, then `check`
set -euo pipefail

mode="${1:-check}"
base="${SHOP_URL:-http://shop.localhost:8080}"
alert=ShopServerErrorRatioHigh
fail() { echo "smoke: FAIL - $*" >&2; exit 1; }
stamp() { date -u +%H:%M:%S; }
# shellcheck source=scripts/checkout.sh
source "$(dirname "$0")/checkout.sh"
# shellcheck source=scripts/alert-catcher.sh
source "$(dirname "$0")/alert-catcher.sh"

# Places Checkouts every <interval> seconds until the catcher has more <status> notifications
# for the alert than <before>, or <attempts> run out. Counts outcomes in `accepted` and `failed`.
traffic_until() { # traffic_until <status> <before> <interval> <attempts>
  accepted=0 failed=0
  for _ in $(seq 1 "$4"); do
    if place_checkout "$base" approve >/dev/null 2>&1; then accepted=$((accepted + 1)); else failed=$((failed + 1)); fi
    [ "$(caught_count "$alert" "$1")" -gt "$2" ] && return 0
    sleep "$3"
  done
  return 1
}

case "$mode" in
  check | fault | recover) ;;
  *) fail "unknown mode '$mode' (check, fault, recover)" ;;
esac

curl -fsS --max-time 10 "$base/healthz" | grep -q '"ok"' || fail "storefront health check at $base/healthz"
page="$(curl -fsS --max-time 10 "$base/")" || fail "storefront home page at $base/"
for product in "Last Lantern" "Canvas Tote"; do
  grep -q "$product" <<<"$page" || fail "seeded product '$product' not on the home page"
done

if [ "$mode" = fault ]; then
  before="$(caught_count "$alert" firing)"
  echo "$(stamp) one Checkout attempt a second until $alert reaches the alert catcher..."
  traffic_until firing "$before" 1 480 || fail "$alert never fired ($accepted accepted, $failed failed)"
  echo "$(stamp) FIRING received: $(caught "$alert" firing | tail -n 1)"
  echo "smoke: OK - fault drill: $failed Checkouts failed, $accepted accepted; $alert fired at the alert catcher"
  exit 0
fi

if [ "$mode" = recover ]; then
  before="$(caught_count "$alert" resolved)"
  echo "$(stamp) one Checkout every 5 s until $alert resolves at the alert catcher..."
  traffic_until resolved "$before" 5 120 || fail "$alert never resolved ($accepted accepted, $failed failed)"
  echo "$(stamp) RESOLVED received: $(caught "$alert" resolved | tail -n 1)"
  echo "$(stamp) recovery traffic: $accepted Checkouts accepted, $failed failed"
fi

# A real Checkout through the storefront, then wait for the worker to settle the Order.
order="$(place_checkout "$base" approve)" || fail "Checkout through the storefront"
status=""
for _ in $(seq 1 30); do
  status="$(order_status "$order")"
  [ "$status" = "Confirmed" ] && break
  sleep 1
done
[ "$status" = "Confirmed" ] || fail "Order not Confirmed after 30 s (last status: ${status:-unknown})"

echo "smoke: OK - $base serves the seeded catalog and a Checkout was Confirmed"
