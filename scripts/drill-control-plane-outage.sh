#!/usr/bin/env bash
# Control-plane outage drill: stop platform-api in the lab cluster and show that the cell keeps
# serving buyers of existing shops from the router's cached routing table, while signups fail
# cleanly; then restore it and show that signups work again. Argo CD's self-heal would undo a
# hand-scaled Deployment within seconds, so automated sync is paused for the drill and always
# restored on exit.
set -euo pipefail

context="${CONTEXT:-k3d-shop}"
namespace="${PLATFORM_NAMESPACE:-platform-dev}"
domain="${SHOP_DOMAIN:-shop.localhost:8080}"
outage_seconds="${OUTAGE_SECONDS:-60}"
k() { kubectl --context "$context" "$@"; }
stamp() { date -u +%H:%M:%S; }
fail() { echo "drill: FAIL - $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
signup() {
  code -H 'content-type: application/json' \
    --data "{\"idempotencyKey\":\"$(openssl rand -hex 12)\",\"handle\":\"drill-$(date +%s)\",\"name\":\"Drill Shop\",\"password\":\"$(openssl rand -hex 12)\"}" \
    "http://$domain/signups"
}

restore() {
  k apply -f deploy/argocd/platform-dev.yaml >/dev/null # puts automated sync back; self-heal scales platform-api up
}
trap restore EXIT

echo "$(stamp) pausing Argo CD automated sync for $namespace and stopping platform-api"
k -n argocd patch application platform-dev --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}' >/dev/null
k -n "$namespace" scale deploy/platform-api --replicas=0 >/dev/null
k -n "$namespace" wait --for=delete pod -l app.kubernetes.io/name=platform-api --timeout=60s >/dev/null 2>&1 || true
down="$(stamp)"

# Buyers of existing shops, once a second for the whole outage: every page must still be served.
served=0 failed=0
for _ in $(seq 1 "$outage_seconds"); do
  for handle in harbor meadow; do
    if [ "$(code "http://$handle.$domain/")" = 200 ]; then served=$((served + 1)); else failed=$((failed + 1)); fi
  done
  sleep 1
done
during="$(signup)"
echo "$(stamp) during the outage ($down onwards): $served shop pages served, $failed failed; a signup answered $during"
[ "$failed" = 0 ] || fail "$failed shop pages failed while the control plane was down"
case "$during" in 5??) ;; *) fail "a signup during the outage answered $during, not a clean 5xx" ;; esac

echo "$(stamp) restoring automated sync; waiting for platform-api"
restore
for _ in $(seq 1 60); do
  [ "$(k -n "$namespace" get deploy platform-api -o jsonpath='{.status.readyReplicas}')" = 1 ] && break
  sleep 2
done
for _ in $(seq 1 30); do
  after="$(signup)"
  [ "$after" = 202 ] && break
  sleep 2
done
[ "$after" = 202 ] || fail "signup did not recover after the control plane returned (last answer $after)"
echo "$(stamp) control plane back: a signup answered 202"
echo "drill: OK - existing shops kept serving through a ${outage_seconds} s control-plane outage; signups failed cleanly and recovered"
