#!/usr/bin/env bash
# Smoke test of a deployed environment through its ingress, from the operator's machine.
# Reports success only when every check passes.
#
# Modes for the bad-release drill (ShopServerErrorRatioHigh, read at the in-cluster alert catcher):
#   check    (default) the storefront serves the catalog and a Checkout is Confirmed
#   fault    with the fault release live: one Checkout attempt a second until the alert fires
#   recover  after merging the revert: one Checkout attempt a second until Checkout works again, and
#            on until the alert resolves, then `check`. The traffic never pauses: the alert needs a
#            minimum request rate, so a lull would end it while Checkout is still broken.
# Drill traffic uses the decline Payment scenario, whose Inventory effects deduct and then release
# Stock, so hundreds of drill Orders leave the seeded Stock unchanged.
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

# One drill Checkout, counted in `accepted` or `failed`; succeeds only when the Checkout was accepted.
accepted=0 failed=0
attempt() {
  if place_checkout "$base" decline >/dev/null 2>&1; then accepted=$((accepted + 1)); else failed=$((failed + 1)); return 1; fi
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
  for _ in $(seq 1 480); do
    attempt || true
    [ "$(caught_count "$alert" firing)" -gt "$before" ] && break
    sleep 1
  done
  [ "$(caught_count "$alert" firing)" -gt "$before" ] || fail "$alert never fired ($accepted accepted, $failed failed)"
  echo "$(stamp) FIRING received: $(caught "$alert" firing | tail -n 1)"
  echo "smoke: OK - fault drill: $failed Checkouts failed, $accepted accepted; $alert fired at the alert catcher"
  exit 0
fi

if [ "$mode" = recover ]; then
  echo "$(stamp) one Checkout attempt a second until Checkout works again..."
  for _ in $(seq 1 600); do attempt && break; sleep 1; done
  [ "$accepted" -gt 0 ] || fail "Checkout never recovered ($failed attempts failed)"
  recovered="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$(stamp) Checkout recovered after $failed failed attempts"

  # Only a resolution after the recovery counts: one before it would mean the alert ended for another reason.
  resolved_after_recovery() { caught "$alert" resolved | jq -c --arg t "$recovered" 'select(.endsAt > $t)' | tail -n 1; }
  echo "$(stamp) one Checkout a second until $alert resolves at the alert catcher..."
  for _ in $(seq 1 600); do
    attempt || true
    [ -n "$(resolved_after_recovery)" ] && break
    sleep 1
  done
  [ -n "$(resolved_after_recovery)" ] || fail "$alert never resolved after the recovery"
  echo "$(stamp) RESOLVED received: $(resolved_after_recovery)"
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
