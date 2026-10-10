#!/usr/bin/env bash
# Alert drill: stop the worker in the lab cluster, show that a Pending order raises
# ShopOldestPendingOrderStale at both receivers, then restore the worker and see it resolve.
# Argo CD's self-heal would undo a hand-scaled worker within seconds, so automated sync is paused
# for the drill and always restored on exit. Discord delivery is checked by eye in the channel;
# the in-cluster alert catcher is checked here.
set -euo pipefail

context="${CONTEXT:-k3d-shop}"
namespace="${NAMESPACE:-shop-dev}"
base="${SHOP_URL:-http://shop.localhost:8080}"
k() { kubectl --context "$context" "$@"; }
stamp() { date -u +%H:%M:%S; }
# shellcheck source=scripts/checkout.sh
source "$(dirname "$0")/checkout.sh"
# shellcheck source=scripts/alert-catcher.sh
source "$(dirname "$0")/alert-catcher.sh"
alert=ShopOldestPendingOrderStale

restore() {
  k -n "$namespace" scale deploy/worker --replicas=1 >/dev/null
  k apply -f deploy/argocd/shop-dev.yaml >/dev/null # puts automated sync back
}
trap restore EXIT

already_firing="$(caught_count "$alert" firing)"
echo "$(stamp) pausing Argo CD automated sync for $namespace and stopping the worker"
k -n argocd patch application shop-dev --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}' >/dev/null
k -n "$namespace" scale deploy/worker --replicas=0 >/dev/null
k -n "$namespace" wait --for=delete pod -l app.kubernetes.io/name=worker --timeout=60s >/dev/null 2>&1 || true

order="$(place_checkout "$base" approve)"
echo "$(stamp) placed an Order with no worker to settle it: status $(order_status "$order")"

echo "$(stamp) waiting for $alert to reach the alert catcher (threshold 60 s)..."
for _ in $(seq 1 240); do [ "$(caught_count "$alert" firing)" -gt "$already_firing" ] && break; sleep 1; done
[ "$(caught_count "$alert" firing)" -gt "$already_firing" ] || { echo "FAIL: alert never fired"; exit 1; }
echo "$(stamp) FIRING received: $(caught "$alert" firing | tail -n 1)"

echo "$(stamp) restoring the worker and Argo CD automated sync"
restore
trap - EXIT
already_resolved_line="$(caught "$alert" resolved | tail -n 1)"
for _ in $(seq 1 240); do
  last="$(caught "$alert" resolved | tail -n 1)"
  [ -n "$last" ] && [ "$last" != "$already_resolved_line" ] && break
  sleep 1
done
[ -n "${last:-}" ] && [ "$last" != "$already_resolved_line" ] || { echo "FAIL: alert never resolved"; exit 1; }
echo "$(stamp) RESOLVED received: $last"
echo "$(stamp) Order is now: $(order_status "$order")"
echo "drill: OK - fired and resolved at the alert catcher; check the Discord channel for the same two messages"
