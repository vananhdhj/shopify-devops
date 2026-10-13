#!/usr/bin/env bash
# What runs where: every cell in the control plane's directory (role, shops by status against its
# capacity, readiness of its catalog and order APIs, its synthetic shop) and, on the lab cluster, each Argo CD
# Application of the cells, the edge, and the control plane (release wave, sync, health, revision) with the
# image digests each one runs, one row per image so a cell left behind stands out; and the
# promoter's latest releases.
#   fleet.sh cluster <context> <platform-namespace>   (port-forwards the control plane's internal listener)
#   fleet.sh compose                                  (the local stack, http://127.0.0.1:8101)
set -euo pipefail

where="${1:-cluster}"
context="${2:-k3d-shop}"
platform_ns="${3:-platform-dev}"
token="$(grep '^PLATFORM_OPERATOR_TOKEN=' .secrets/dev.env | cut -d= -f2-)"
[ -n "$token" ] || { echo "PLATFORM_OPERATOR_TOKEN missing from .secrets/dev.env (run make secrets)" >&2; exit 1; }

case "$where" in
  compose) url="http://127.0.0.1:8101" ;;
  cluster)
    url="http://127.0.0.1:18102"
    kubectl --context "$context" -n "$platform_ns" port-forward svc/platform-api 18102:8101 >/dev/null 2>&1 &
    pf=$!
    trap 'kill "$pf" 2>/dev/null; wait "$pf" 2>/dev/null || true' EXIT
    for _ in $(seq 1 40); do curl -fsS --max-time 1 -o /dev/null "$url/health/live" 2>/dev/null && break; sleep 0.25; done ;;
  *) echo "unknown target '$where' (cluster, compose)" >&2; exit 2 ;;
esac

cells="$(curl -fsS --max-time 10 -H "x-operator-token: $token" "$url/operator/cells")" ||
  { echo "fleet: the control plane at $url did not answer /operator/cells" >&2; exit 1; }
jq -r '
  ["CELL", "ROLE", "PLACED/CAP", "ACTIVE", "PROVISIONING", "SUSPENDED", "FROZEN", "DELETING", "DELETED", "CATALOG", "ORDERS", "SYNTHETIC"],
  (.cells[] | [.id, .role, "\(.placed)/\(.capacity)", .shops.ACTIVE, .shops.PROVISIONING, .shops.SUSPENDED,
    ((.shops.MOVING // 0) + (.shops.RESTORING // 0)), .shops.DELETING, .shops.DELETED, (.apis.catalog // "unregistered"), (.apis.orders // "unregistered"),
    (if .synthetic then "\(.synthetic.handle) \(.synthetic.status)" else "-" end)])
  | @tsv' <<<"$cells" | column -t -s $'\t'

# The promoter's latest releases (Phase 4): which wave each soaked in, and what became of it.
promotions="$(curl -fsS --max-time 10 -H "x-operator-token: $token" "$url/operator/promotions" 2>/dev/null || echo '{"promotions":[]}')"
if [ "$(jq '.promotions | length' <<<"$promotions")" -gt 0 ]; then
  echo
  jq -r '
    ["PROMOTION", "WAVE", "CELLS", "STATE", "SOAK STARTED", "DECIDED", "FAILURE", "EXPOSED"],
    (.promotions[:5][] | [.id, .wave, (.cells | join(",")), .state, .soakStartedAt[11:19], ((.decidedAt // "-")[11:19]),
      (if .failure then "\(.failure.cell) \(.failure.check)" else "-" end),
      (if .exposedTenants != null then "\(.exposedTenants) tenants in \(.exposedCells | join(","))" else "-" end)])
    | @tsv' <<<"$promotions" | column -t -s $'\t'
fi

[ "$where" = cluster ] || exit 0

apps="$(kubectl --context "$context" -n argocd get applications.argoproj.io -o json |
  jq '[.items[] | select(.metadata.name | test("^(cell-|edge-|platform-)")) | {
    name: .metadata.name,
    wave: (.metadata.labels["shop.example/wave"] // "-"),
    sync: (.status.sync.status // "-"),
    health: (.status.health.status // "-"),
    revision: ((.status.sync.revision // "-")[0:7]),
    images: [(.status.summary.images // [])[] | (split("/") | last) | capture("^(?<unit>[^@:]+)(?::(?<tag>[^@]+))?(?:@sha256:(?<digest>.{12}))?")
      | {unit, version: ([.tag, .digest] | map(select(.)) | join("@") | if . == "" then "-" else . end)}]
  }] | sort_by(.name)')"
echo
jq -r '["APPLICATION", "WAVE", "SYNC", "HEALTH", "REVISION"], (.[] | [.name, .wave, .sync, .health, .revision]) | @tsv' <<<"$apps" | column -t -s $'\t'
echo
jq -r '
  (map(.name)) as $names
  | ([.[].images[].unit] | unique) as $units
  | (["IMAGE"] + $names),
    ($units[] as $unit | [$unit] + [.[] | ([.images[] | select(.unit == $unit) | .version] | first // "-")])
  | @tsv' <<<"$apps" | column -t -s $'\t'
