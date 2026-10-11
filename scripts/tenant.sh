#!/usr/bin/env bash
# The platform operator's shop actions, through the control plane's internal listener (never on
# an ingress). Locally that is http://127.0.0.1:8101 (Compose); for the lab cluster, port-forward
# it first and set PLATFORM_URL.
#   tenant.sh list
#   tenant.sh events <handle>
#   tenant.sh suspend|reinstate|delete <handle>
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
  *)
    echo "unknown action '$action' (list, events, suspend, reinstate, delete)" >&2; exit 2 ;;
esac
