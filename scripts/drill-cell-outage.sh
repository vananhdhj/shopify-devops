#!/usr/bin/env bash
# Cell outage drill: stop one cell's PostgreSQL in the lab cluster and show that the failure stays
# in that cell. Its shop answers "temporarily unavailable" while a shop in every other cell keeps
# serving; then the database is restored and the shop recovers. Prints the timings: how long
# until the shop failed, how many requests the other cells failed, and how long recovery took.
# Self-heal would scale the database back within seconds, so the cell's automated sync is paused
# for the drill (the ApplicationSet leaves that field alone) and always restored on exit.
#   drill-cell-outage.sh <cell>    (default dedicated-1)
set -euo pipefail

cell="${1:-dedicated-1}"
context="${CONTEXT:-k3d-shop}"
platform_ns="${PLATFORM_NAMESPACE:-platform-dev}"
domain="${SHOP_DOMAIN:-shop.localhost:8080}"
outage_seconds="${OUTAGE_SECONDS:-60}"
app="cell-$cell-dev"
k() { kubectl --context "$context" "$@"; }
stamp() { date -u +%H:%M:%S; }
now() { date +%s; }
fail() { echo "drill: FAIL - $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$1.$domain/"; }
registry() { k -n "$platform_ns" exec platform-db-0 -- psql -U postgres -d platform -Atc "$1"; }

[ -f "deploy/cells/dev/$cell/cell.json" ] || fail "no cell '$cell' under deploy/cells/dev"
namespace="$(jq -r .namespace "deploy/cells/dev/$cell/cell.json")"

# A shop in the cell under drill, and one in every other registered cell.
target="$(registry "SELECT handle FROM platform.tenants WHERE cell = '$cell' AND status = 'ACTIVE' ORDER BY created_at LIMIT 1")"
[ -n "$target" ] || fail "no active shop in $cell (for dedicated-1: sign up a plus shop first)"
read -r -a others <<<"$(registry "SELECT string_agg(handle, ' ') FROM (
  SELECT DISTINCT ON (cell) handle FROM platform.tenants
   WHERE status = 'ACTIVE' AND cell <> '$cell' AND cell IN (SELECT id FROM platform.cells WHERE registered_at IS NOT NULL)
   ORDER BY cell, created_at) shops")"
[ "${#others[@]}" -gt 0 ] || fail "no active shop in any other cell"
for handle in "$target" "${others[@]}"; do
  [ "$(code "$handle")" = 200 ] || fail "$handle does not answer 200 before the drill"
done
echo "$(stamp) $cell's shop: $target; other cells' shops: ${others[*]}"

restore() {
  k -n "$namespace" scale statefulset/postgres --replicas=1 >/dev/null 2>&1 || true
  k -n argocd patch application "$app" --type merge \
    -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}' >/dev/null 2>&1 || true
}
trap restore EXIT

k apply -f deploy/argocd/cells-dev.yaml >/dev/null # the ApplicationSet that lets the pause hold
echo "$(stamp) pausing automated sync of $app and stopping $cell's PostgreSQL"
k -n argocd patch application "$app" --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}' >/dev/null
k -n "$namespace" scale statefulset/postgres --replicas=0 >/dev/null
k -n "$namespace" wait --for=delete pod/postgres-0 --timeout=90s >/dev/null 2>&1 || true
down="$(now)"
echo "$(stamp) $cell's PostgreSQL is down"

# Once a second for the outage: the cell's shop must fail, every other cell's shop must serve.
first_failure="" target_codes="" served=0 failed=0
for _ in $(seq 1 "$outage_seconds"); do
  answer="$(code "$target")"
  if [ "$answer" != 200 ] && [ -z "$first_failure" ]; then
    first_failure=$(($(now) - down))
    echo "$(stamp) $target answers $answer"
  fi
  case " $target_codes " in *" $answer "*) ;; *) target_codes="$target_codes $answer" ;; esac
  for handle in "${others[@]}"; do
    if [ "$(code "$handle")" = 200 ]; then served=$((served + 1)); else failed=$((failed + 1)); fi
  done
  sleep 1
done
automated_during="$(k -n argocd get application "$app" -o jsonpath='{.spec.syncPolicy.automated}')"
echo "$(stamp) during the outage: $target answered${target_codes}; other cells served $served pages, failed $failed"
[ -n "$first_failure" ] || fail "$target kept answering 200 with its cell's database down"
[ -z "$automated_during" ] || fail "$app's automated sync came back during the drill"

echo "$(stamp) restoring $cell's PostgreSQL and automated sync"
restored="$(now)"
restore
recovered=""
for _ in $(seq 1 180); do
  [ "$(code "$target")" = 200 ] && recovered=$(($(now) - restored)) && break
  sleep 1
done
[ -n "$recovered" ] || fail "$target did not recover within 180 s of the restore"
echo "$(stamp) $target answers 200 again"
for _ in $(seq 1 60); do
  [ "$(k -n argocd get application "$app" -o jsonpath='{.status.sync.status} {.status.health.status}')" = "Synced Healthy" ] && break
  sleep 2
done
echo "$(stamp) $app: $(k -n argocd get application "$app" -o jsonpath='{.status.sync.status} {.status.health.status}'), automated sync $(k -n argocd get application "$app" -o jsonpath='{.spec.syncPolicy.automated}')"

[ "$failed" = 0 ] || fail "$failed requests to other cells' shops failed while $cell's database was down"
echo "drill: OK - $cell's shop failed ${first_failure} s after its database stopped and recovered ${recovered} s after the restore; other cells (${others[*]}) served all $served pages"
