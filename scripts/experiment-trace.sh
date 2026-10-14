#!/usr/bin/env bash
# Phase 7's trace experiment on the lab cluster: a buyer's Checkout of one shop through the
# ingress, then its trace found in Tempo by the Order id (TraceQL) and printed as its spans, in
# start order, with each one's unit, duration, and the shop and cell it names. The bound: one
# trace holds the edge, the storefront, the order service, the catalog API, and the worker's
# settlement, across the outbox and the queue.
#   experiment-trace.sh [handle]         default: a starter shop in pool-1
set -euo pipefail

domain="${SHOP_DOMAIN:-shop.localhost:8080}"
fail() { echo "experiment: $*" >&2; exit 1; }
platformsql() { kubectl -n platform-dev exec platform-db-0 -- psql -U postgres -d platform -Atc "$1"; }
handle="${1:-$(platformsql "SELECT handle FROM platform.tenants WHERE cell = 'pool-1' AND status = 'ACTIVE' AND NOT internal ORDER BY created_at LIMIT 1")}"
cell="$(platformsql "SELECT cell FROM platform.tenants WHERE handle = '$handle'")"
namespace="$([ "$cell" = pool-1 ] && echo shop-dev || echo "cell-$cell-dev")"
tenant="$(platformsql "SELECT id FROM platform.tenants WHERE handle = '$handle'")"
product="$(kubectl -n "$namespace" exec postgres-0 -- psql -U postgres -d shop -Atc \
  "SELECT id FROM catalog.products WHERE tenant_id = '$tenant' AND stock > 0 ORDER BY name LIMIT 1")"
[ -n "$product" ] || fail "$handle has no product in stock"

# 1. A Checkout through the ingress, as a buyer's browser would.
jar="$(mktemp)"
trap 'rm -f "$jar" "${forward_log:-}"; kill "${forward:-}" 2>/dev/null || true' EXIT
shop() { local path="$1"; shift; curl -sS --max-time 10 -c "$jar" -b "$jar" "$@" "http://$handle.$domain$path"; }
shop /cart/items -o /dev/null --data "productId=$product&action=add"
key="$(shop /checkout | grep -o 'name="checkoutKey" value="[^"]*"' | sed 's/.*value="//; s/"$//')"
order="$(shop /orders -o /dev/null -w '%{redirect_url}' --data "checkoutKey=$key&paymentScenario=approve" | sed -n 's#.*/orders/\([0-9a-f-]*\)?.*#\1#p')"
[ -n "$order" ] || fail "the Checkout was not accepted"
echo "$(date -u +%H:%M:%S) Checkout of $handle ($cell): Order $order"

# 2. Its trace in Tempo, by the Order id.
# A busy API server can take a while to open the forward (Phase 7 evidence): wait for it.
forward_log="$(mktemp)"
kubectl -n monitoring port-forward svc/tempo 13200:3200 >"$forward_log" 2>&1 &
forward=$!
for _ in $(seq 1 60); do grep -q "Forwarding from" "$forward_log" && break; sleep 1; done
grep -q "Forwarding from" "$forward_log" || fail "no port-forward to Tempo: $(cat "$forward_log")"
query="$(jq -rn --arg o "$order" '"{ span.order.id = \"\($o)\" }" | @uri')"
trace=""
for _ in $(seq 1 60); do
  # A query that fails (Tempo still starting, the forward dropping) is retried, never fatal.
  trace="$(curl -s --max-time 10 "http://127.0.0.1:13200/api/search?q=$query&start=$(($(date +%s) - 900))&end=$(($(date +%s) + 60))" | jq -r '.traces[0].traceID // empty' 2>/dev/null || true)"
  if [ -n "$trace" ] && curl -s --max-time 10 "http://127.0.0.1:13200/api/v2/traces/$trace" | jq -e '[.trace.resourceSpans[].scopeSpans[].spans[].name] | index("settle order")' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
[ -n "$trace" ] || fail "no trace names Order $order"
curl -s "http://127.0.0.1:13200/api/v2/traces/$trace" >.local/trace.json
echo "trace $trace:"
jq -r '
  [.trace.resourceSpans[] | (.resource.attributes | map({(.key): .value.stringValue}) | add) as $r
   | .scopeSpans[].spans[]
   | (.attributes // [] | map({(.key): (.value.stringValue // .value.intValue)}) | add // {}) as $a
   | {start: (.startTimeUnixNano | tonumber), ms: (((.endTimeUnixNano | tonumber) - (.startTimeUnixNano | tonumber)) / 1e6),
      service: $r["service.name"], cell: ($r.cell // $a.cell // "-"), name, tenant: ($a["tenant.id"] // "")}]
  | sort_by(.start) | (.[0].start) as $t0 | .[]
  | "  +\(((.start - $t0) / 1e6) | floor | tostring | (" " * (6 - length)) + .) ms  \(.ms | floor | tostring | (" " * (5 - length)) + .) ms  \(.service | . + (" " * (17 - length))) \(.cell | . + (" " * (12 - length))) \(.name)\(if .tenant != "" then "  [tenant \(.tenant[0:8])]" else "" end)"
' .local/trace.json

services="$(jq -r '[.trace.resourceSpans[].resource.attributes[] | select(.key == "service.name") | .value.stringValue] | unique | join(",")' .local/trace.json)"
spans="$(jq '[.trace.resourceSpans[].scopeSpans[].spans[]] | length' .local/trace.json)"
echo "services: $services; $spans spans"
[ "$services" = "catalog-cart-api,order-service,router,storefront,worker" ] || fail "the trace lacks a unit: $services"
jq -e '[.trace.resourceSpans[].scopeSpans[].spans[].name] | (index("outbox dispatch") and index("settle order"))' .local/trace.json >/dev/null ||
  fail "the trace does not cross the queue"
echo "experiment: OK - one trace from the edge through the queue to the settlement, $spans spans in 5 units"
