#!/usr/bin/env bash
# The autoscaling experiment (Phase 7, ticket 06) on the lab cluster: k6 asks for several pool-1
# shops' home pages through the ingress (tests/load/autoscale.js) while the storefront's and the
# catalog API's replicas, their CPU, and the VM's load and memory are sampled every 10 s; then
# sampling goes on until both are back at one replica. Records when each scaled out and back in.
#   experiment-autoscale.sh            RATE=8 DURATION=4m SHOPS=<handles> (default: pool-1's starter shops)
set -euo pipefail

rate="${RATE:-8}"
duration="${DURATION:-4m}"
k6_image="grafana/k6@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d" # 1.3.0
state=.local/autoscale
mkdir -p "$state"
fail() { echo "experiment: $*" >&2; exit 1; }
platformsql() { kubectl -n platform-dev exec platform-db-0 -- psql -U postgres -d platform -Atc "$1"; }
shops="${SHOPS:-$(platformsql "SELECT string_agg(handle, ',') FROM (SELECT handle FROM platform.tenants WHERE cell = 'pool-1' AND status = 'ACTIVE' AND NOT internal AND plan = 'starter' ORDER BY created_at LIMIT 4) s")}"
[ -n "$shops" ] || fail "no starter shop in pool-1"
replicas() { kubectl -n shop-dev get deploy "$1" -o jsonpath='{.status.readyReplicas}'; }
for unit in storefront catalog-cart-api; do kubectl -n shop-dev get hpa "$unit" >/dev/null || fail "no autoscaler for $unit"; done
echo "$(date -u +%H:%M:%S) shops: $shops; $rate requests a second each for $duration"

samples="$state/samples.log"
echo "time storefront catalog-cart-api storefront_cpu catalog_cpu vm_load vm_available_mib" >"$samples"
sample() {
  local cpu
  cpu="$(kubectl -n shop-dev top pods --no-headers 2>/dev/null | awk '/^storefront-/ {s += $2} /^catalog-cart-api-/ {c += $2} END {printf "%dm %dm", s, c}')"
  echo "$(date -u +%H:%M:%S) $(replicas storefront) $(replicas catalog-cart-api) $cpu $(colima ssh -- cat /proc/loadavg | cut -d' ' -f1) $(colima ssh -- free -m | awk '/^Mem:/ {print $7}')" >>"$samples"
}
(while true; do sample; sleep 10; done) &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true' EXIT

started="$(date -u +%s)"
docker run --rm --network k3d-shop -v "$PWD/tests/load:/scripts:ro" -v "$PWD/$state:/out" \
  -e SHOPS="$shops" -e RATE="$rate" -e DURATION="$duration" "$k6_image" run --quiet /scripts/autoscale.js >"$state/k6.log" 2>&1 || true
load_ended="$(date -u +%s)"
echo "$(date -u +%H:%M:%S) load ended; waiting for both units to scale back in"
for _ in $(seq 1 90); do
  [ "$(replicas storefront)" = 1 ] && [ "$(replicas catalog-cart-api)" = 1 ] && break
  sleep 10
done
sleep 10
kill "$sampler" 2>/dev/null || true
[ -s "$state/result.json" ] || { tail -20 "$state/k6.log" >&2; fail "k6 wrote no result"; }

column -t "$samples"
first_above() { awk -v col="$1" 'NR > 1 && $col > 1 {print $1; exit}' "$samples"; }
last_above() { awk -v col="$1" 'NR > 1 && $col > 1 {t = $1} END {print t}' "$samples"; }
peak() { awk -v col="$1" 'NR > 1 && $col > m {m = $col} END {print m + 0}' "$samples"; }
echo "load from $(date -u -r "$started" +%H:%M:%S) to $(date -u -r "$load_ended" +%H:%M:%S)"
echo "storefront: up to $(peak 2) replicas, above one from $(first_above 2) to $(last_above 2)"
echo "catalog-cart-api: up to $(peak 3) replicas, above one from $(first_above 3) to $(last_above 3)"
echo "VM load peaked at $(peak 6); available memory fell to $(awk 'NR > 1 && (m == "" || $7 < m) {m = $7} END {print m}' "$samples") MiB"
jq -r '"answers: \(.ok) 2xx, \(.other) other \(.byStatus // {} | tostring) (status 0: no answer within 10 s); p95 \(.p95 | floor) ms"' "$state/result.json"
[ "$(peak 2)" -gt 1 ] || fail "the storefront never scaled out"
[ "$(replicas storefront)" = 1 ] && [ "$(replicas catalog-cart-api)" = 1 ] || fail "not back at one replica"
echo "experiment: OK - the storefront scaled out under load and back in after it"
