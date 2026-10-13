#!/usr/bin/env bash
# The noisy-neighbour experiment (Phase 5's exit gate) on the lab cluster. Three quiet starter shops
# and one noisy one, all in pool-1, created on the first run and reused after (.local/). k6 runs in
# a container on the k3d network (tests/load/noisy-neighbour.js): a baseline of the quiet shops'
# buyer journeys, then the same with the noisy shop at 10x its rate quota. The bound: the noisy shop
# gets 429s and no 5xx; every quiet shop's Checkout p95 stays within 20% of its baseline. The VM's
# load is sampled throughout; a run on a stalled host (load over STALL_LOAD) is reported as void.
#   experiment-noisy-neighbour.sh            PHASE_DURATION=5m NOISY_RATE=100 STALL_LOAD=12
set -euo pipefail

domain="${SHOP_DOMAIN:-shop.localhost:8080}"
phase="${PHASE_DURATION:-5m}"
noisy_rate="${NOISY_RATE:-100}"
stall_load="${STALL_LOAD:-12}"
k6_image="grafana/k6@sha256:3ddc8b1a33a2c3d8edc6e99b6a762ae36cba08788463458f5e6a7703e14eb77d" # 1.3.0
state=.local/noisy-neighbour
shops_file="$state/shops.json"
mkdir -p "$state"
stamp() { date -u +%H:%M:%S; }
fail() { echo "experiment: $*" >&2; exit 1; }

# A starter shop with one product, through the platform's signup and its Merchant's admin.
make_shop() {
  local handle="$1" password tenant status jar
  password="$(openssl rand -hex 12)"
  tenant="$(curl -fsS --max-time 20 -H 'content-type: application/json' \
    --data "{\"idempotencyKey\":\"$(openssl rand -hex 12)\",\"handle\":\"$handle\",\"name\":\"Neighbour $handle\",\"password\":\"$password\",\"plan\":\"starter\"}" \
    "http://$domain/signups" | jq -r .tenantId)" || fail "signing up $handle"
  for _ in $(seq 1 60); do
    status="$(curl -fsS --max-time 5 -H 'accept: application/json' "http://$domain/signups/$tenant" | jq -r .status)"
    [ "$status" = ACTIVE ] && break
    sleep 1
  done
  [ "$status" = ACTIVE ] || fail "$handle not ACTIVE"
  jar="$(mktemp)"
  for _ in $(seq 1 20); do
    [ "$(curl -sS --max-time 10 -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' --data "password=$password" "http://$handle.$domain/admin/session")" = "http://$handle.$domain/admin" ] && break
    sleep 1
  done
  curl -fsS --max-time 10 -b "$jar" -o /dev/null --data "name=Neighbour+Mug&priceMinor=900&stock=1000" "http://$handle.$domain/admin/products" ||
    fail "adding $handle's product"
  rm -f "$jar"
  echo "$(stamp) $handle ready ($tenant)" >&2
  jq -n --arg handle "$handle" --arg tenant "$tenant" '{handle: $handle, tenant: $tenant}'
}

if [ ! -s "$shops_file" ]; then
  suffix="$(openssl rand -hex 3)"
  {
    for name in quiet-1 quiet-2 quiet-3 noisy; do make_shop "nn-$name-$suffix"; done
  } | jq -s . >"$shops_file"
fi
quiet="$(jq -r '[.[] | select(.handle | contains("-quiet-")) | .handle] | join(",")' "$shops_file")"
noisy="$(jq -r '.[] | select(.handle | contains("-noisy-")) | .handle' "$shops_file")"
echo "$(stamp) quiet shops: $quiet; noisy shop: $noisy; phases of $phase; noisy rate $noisy_rate/s"

# The VM's load, every 10 s, for the whole run.
load_log="$state/load.log"
: >"$load_log"
(while true; do echo "$(date -u +%H:%M:%S) $(colima ssh -- cat /proc/loadavg | cut -d' ' -f1)" >>"$load_log"; sleep 10; done) &
sampler=$!
trap 'kill "$sampler" 2>/dev/null || true' EXIT

started="$(stamp)"
docker run --rm --network k3d-shop -v "$PWD/tests/load:/scripts:ro" -v "$PWD/$state:/out" \
  -e QUIET="$quiet" -e NOISY="$noisy" -e PHASE_DURATION="$phase" -e NOISY_RATE="$noisy_rate" \
  "$k6_image" run --quiet /scripts/noisy-neighbour.js >"$state/k6.log" 2>&1 || true
kill "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true
[ -s "$state/result.json" ] || { tail -20 "$state/k6.log" >&2; fail "k6 wrote no result"; }

peak="$(awk '{print $2}' "$load_log" | sort -n | tail -1)"
echo "$(stamp) run $started to $(stamp); VM load average peaked at $peak (stall threshold $stall_load)"
jq -r '
  "noisy shop: \(.noisy["429"]) × 429, \(.noisy["5xx"]) × 5xx, \(.noisy["2xx"]) × 2xx, \(.noisy["none"]) no answer",
  (.quiet | to_entries[] | "\(.key): Checkout p95 \(.value.baseline.checkoutP95 * 1000 | round) ms baseline → \(.value.noise.checkoutP95 * 1000 | round) ms with the noise (\(if .value.baseline.checkoutP95 > 0 then ((.value.noise.checkoutP95 / .value.baseline.checkoutP95) - 1) * 100 | round | tostring else "n/a" end)%); \(.value.baseline.checkouts)+\(.value.noise.checkouts) Checkouts, \(.value.baseline.failures)+\(.value.noise.failures) journeys failed")
' "$state/result.json"

verdict="$(jq -r '
  [ (.noisy["429"] > 0), (.noisy["5xx"] == 0),
    (.quiet | to_entries | all(.value.baseline.checkouts > 0 and .value.noise.checkouts > 0
      and .value.noise.checkoutP95 <= 1.2 * .value.baseline.checkoutP95)) ] | all' "$state/result.json")"
if awk -v p="$peak" -v t="$stall_load" 'BEGIN { exit !(p > t) }'; then
  echo "experiment: VOID - the host stalled the node (load $peak); rerun on a quiet host"
  exit 2
fi
[ "$verdict" = true ] || fail "the bound was not met (see above)"
echo "experiment: OK - the noisy shop got 429s and no 5xx; every quiet shop's Checkout p95 stayed within 20% of its baseline"
