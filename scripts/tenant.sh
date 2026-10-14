#!/usr/bin/env bash
# The platform operator's shop actions, through the control plane's internal listener (never on
# an ingress). Locally that is http://127.0.0.1:8101 (Compose); for the lab cluster, port-forward
# it first and set PLATFORM_URL.
#   tenant.sh list
#   tenant.sh events <handle>
#   tenant.sh suspend|reinstate|delete <handle>
#   tenant.sh move <handle> <cell>      freezes the shop, then follows the move's steps to the end
#   tenant.sh exports <handle>          the shop's exports, newest first, with their row counts
#   tenant.sh export <handle>           exports the shop now
#   tenant.sh restore <handle> <export> restores the shop to an export (what changed since is lost)
set -euo pipefail

url="${PLATFORM_URL:-http://127.0.0.1:8101}"
token="$(grep '^PLATFORM_OPERATOR_TOKEN=' .secrets/dev.env | cut -d= -f2-)"
[ -n "$token" ] || { echo "PLATFORM_OPERATOR_TOKEN missing from .secrets/dev.env (run make secrets)" >&2; exit 1; }
call() { curl -fsS --max-time 10 -H "x-operator-token: $token" "$@"; }

action="${1:-list}"
handle="${2:-}"
case "$action" in
  list)
    call "$url/operator/tenants" | jq -r '.tenants[] | [.handle, .status, (.cell // "-"), .name] | @tsv' | column -t -s $'\t' ;;
  events)
    [ -n "$handle" ] || { echo "usage: tenant.sh events <handle>" >&2; exit 2; }
    call "$url/operator/tenants/$handle/events" | jq -r '.events[] | [.at, .step, (.toStatus // "-"), .actor, (.detail | tostring)] | @tsv' ;;
  suspend | reinstate | delete)
    [ -n "$handle" ] || { echo "usage: tenant.sh $action <handle>" >&2; exit 2; }
    call -X POST "$url/operator/tenants/$handle/$action" | jq -r '"\(.handle): \(.status)"' ;;
  move)
    cell="${3:-}"
    [ -n "$handle" ] && [ -n "$cell" ] || { echo "usage: tenant.sh move <handle> <cell>" >&2; exit 2; }
    # Events from before this move are not its steps.
    seen="$(call "$url/operator/tenants/$handle/events" | jq '.events | length')"
    answer="$(curl -sS --max-time 10 -H "x-operator-token: $token" -H 'content-type: application/json' \
      --data "{\"cell\":\"$cell\"}" -w '\n%{http_code}' "$url/operator/tenants/$handle/move")"
    code="$(tail -n1 <<<"$answer")"
    [ "$code" = 202 ] || { echo "move refused ($code): $(sed '$d' <<<"$answer")" >&2; exit 1; }
    sed '$d' <<<"$answer" | jq -r '"\(.handle): MOVING, \(.from) -> \(.to), plan after the move: \(.planAfter)"'
    for _ in $(seq 1 360); do
      steps="$(call "$url/operator/tenants/$handle/events" | jq -c --argjson seen "$seen" '.events[$seen:][]')"
      if grep -q '"step":"move_\(source_purged\|undone\)"' <<<"$steps"; then
        jq -r '"\(.at) \(.step) \(.toStatus // "-") \(.detail | del(.checksums) | tostring)"' <<<"$steps"
        jq -r 'select(.step == "move_verified") | .detail.checksums | to_entries[] | "  \(.key): \(.value.rows) rows, md5 \(.value.md5)"' <<<"$steps"
        grep -q '"step":"move_source_purged"' <<<"$steps" || { echo "the move was undone; the shop is ACTIVE where it was" >&2; exit 1; }
        echo "moved: $(jq -r 'select(.step == "move_switched") | "frozen \(.detail.frozenMs) ms; now in \(.detail.to)"' <<<"$steps")"
        exit 0
      fi
      sleep 0.5
    done
    echo "the move has not finished after 3 minutes; see tenant.sh events $handle" >&2; exit 1 ;;
  exports)
    [ -n "$handle" ] || { echo "usage: tenant.sh exports <handle>" >&2; exit 2; }
    call "$url/operator/tenants/$handle/exports" |
      jq -r '["EXPORT", "TAKEN", "KIND", "CELL", "PRODUCTS", "CARTS", "ORDERS", "KB"],
        (.exports[] | [.id, .takenAt, .kind, .cell, .rows["catalog.products"], .rows["catalog.carts"], .rows["orders.orders"], (.bytes / 1024 | floor)])
        | @tsv' | column -t -s $'\t' ;;
  export)
    [ -n "$handle" ] || { echo "usage: tenant.sh export <handle>" >&2; exit 2; }
    call -X POST "$url/operator/tenants/$handle/exports" | jq -r '"\(.handle): export requested (tenant.sh exports \(.handle) lists it once written)"' ;;
  restore)
    export_id="${3:-}"
    [ -n "$handle" ] && [ -n "$export_id" ] || { echo "usage: tenant.sh restore <handle> <export>" >&2; exit 2; }
    seen="$(call "$url/operator/tenants/$handle/events" | jq '.events | length')"
    answer="$(curl -sS --max-time 10 -H "x-operator-token: $token" -H 'content-type: application/json' \
      --data "{\"export\":\"$export_id\"}" -w '\n%{http_code}' "$url/operator/tenants/$handle/restore")"
    code="$(tail -n1 <<<"$answer")"
    [ "$code" = 202 ] || { echo "restore refused ($code): $(sed '$d' <<<"$answer")" >&2; exit 1; }
    sed '$d' <<<"$answer" | jq -r '"\(.handle): RESTORING to the export of \(.takenAt); \(.warning)"'
    for _ in $(seq 1 360); do
      steps="$(call "$url/operator/tenants/$handle/events" | jq -c --argjson seen "$seen" '.events[$seen:][]')"
      if [ -n "$(jq -c 'select(.step == "restored" or .step == "restore_undone" or (.step == "restore_failed" and .toStatus == "ACTIVE"))' <<<"$steps")" ]; then
        jq -r '"\(.at) \(.step) \(.toStatus // "-") \(.detail | del(.checksums) | tostring)"' <<<"$steps"
        grep -q '"step":"restored"' <<<"$steps" || { echo "the restore was undone; the shop is ACTIVE as it was" >&2; exit 1; }
        echo "restored: $(jq -r 'select(.step == "restored") | "frozen \(.detail.frozenMs) ms"' <<<"$steps")"
        exit 0
      fi
      sleep 0.5
    done
    echo "the restore has not finished after 3 minutes; see tenant.sh events $handle" >&2; exit 1 ;;
  *)
    echo "unknown action '$action' (list, events, suspend, reinstate, delete, move, exports, export, restore)" >&2; exit 2 ;;
esac
