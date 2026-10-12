#!/usr/bin/env bash
# Copies .secrets/ into the cluster, when the lab cluster is reachable: each cell's `shop-secrets`
# from its own file into its own namespace, the control plane's `platform-secrets`, and `cell-credentials` (one key per
# cell and secret, mounted as files), each namespace getting only what it needs. Secrets never live
# in Git; Argo CD applications only reference them by name.
# The Merchants' plaintext passwords stay local: the cluster needs only their hashes.
# Pods read secrets at startup, so after rotating a value, restart the affected Deployments.
set -euo pipefail

context="$1"
platform_namespace="$2"
edge_namespace="$3"

if ! kubectl --context "$context" get --raw /readyz >/dev/null 2>&1; then
  # Not an error (Compose needs only the file), but the cluster now lags the file: a release that
  # reads a new key would fail to start its pods there (Phase 1 evidence, 2026-10-11).
  echo "WARNING: cluster context $context not reachable; its Secrets were NOT updated." >&2
  echo "         Re-run make secrets once it is reachable, before Argo CD syncs a release that reads a new key." >&2
  exit 0
fi

# Writes the KEY=value lines read from stdin as Secret $2 in namespace $1.
apply_secret() {
  kubectl --context "$context" create namespace "$1" --dry-run=client -o yaml |
    kubectl --context "$context" apply -f - >/dev/null
  kubectl --context "$context" -n "$1" create secret generic "$2" --from-env-file=/dev/stdin --dry-run=client -o yaml |
    kubectl --context "$context" -n "$1" label --local -f - app.kubernetes.io/part-of=shop -o yaml |
    kubectl --context "$context" apply -f - >/dev/null
  echo "secret $2 applied to $1 on $context"
}

# Each cell: its own file, into the namespace its cell.json names, so a cell's pods can read no
# other cell's secrets.
for cell_json in deploy/cells/dev/*/cell.json; do
  cell="$(basename "$(dirname "$cell_json")")"
  cell_namespace="$(sed -n 's/.*"namespace": *"\([^"]*\)".*/\1/p' "$cell_json")"
  apply_secret "$cell_namespace" shop-secrets <".secrets/cells/$cell.env"
done
# The control plane: its own database passwords, its tokens, and the seeded shops' password hashes.
grep -E '^(DB_PLATFORM_[A-Z_]+|PLATFORM_[A-Z_]+_TOKEN|MERCHANT_CREDENTIALS)=' .secrets/dev.env |
  apply_secret "$platform_namespace" platform-secrets
# The per-cell secrets the platform-level units hold, as files `<cell>.<key>` (see
# scripts/secrets.sh): the control plane's cell and storefront tokens, the edge's tenant-context
# secrets. The integration tests' throwaway cells (test-*) stay local.
apply_cell_credentials() {
  local files=() f
  for f in "$2"/*; do
    case "$(basename "$f")" in test-*) ;; *) files+=("--from-file=$f") ;; esac
  done
  kubectl --context "$context" -n "$1" create secret generic cell-credentials "${files[@]}" --dry-run=client -o yaml |
    kubectl --context "$context" -n "$1" label --local -f - app.kubernetes.io/part-of=shop -o yaml |
    kubectl --context "$context" apply -f - >/dev/null
  echo "secret cell-credentials applied to $1 on $context"
}
apply_cell_credentials "$platform_namespace" .secrets/mounts/platform
# The edge: the token it reads the routing table with, and every cell's tenant-context secret.
grep '^PLATFORM_ROUTER_TOKEN=' .secrets/dev.env | apply_secret "$edge_namespace" edge-secrets
apply_cell_credentials "$edge_namespace" .secrets/mounts/edge

# The monitoring namespace: Grafana's admin login, and the Discord webhook Alertmanager reads
# from a mounted file. Without a webhook in .secrets/dev.env, a placeholder keeps Alertmanager
# running (Discord deliveries fail, the in-cluster alert catcher still receives every alert).
value() { grep -h "^$1=" .secrets/dev.env | cut -d= -f2-; }
kubectl --context "$context" create namespace monitoring --dry-run=client -o yaml |
  kubectl --context "$context" apply -f - >/dev/null
kubectl --context "$context" -n monitoring create secret generic grafana-admin \
  --from-literal=admin-user=admin --from-literal=admin-password="$(value GRAFANA_ADMIN_PASSWORD)" \
  --dry-run=client -o yaml | kubectl --context "$context" apply -f - >/dev/null
webhook="$(value DISCORD_WEBHOOK_URL)"
kubectl --context "$context" -n monitoring create secret generic alertmanager-discord \
  --from-literal=url="${webhook:-https://discord.invalid/not-configured}" \
  --dry-run=client -o yaml | kubectl --context "$context" apply -f - >/dev/null
echo "secrets grafana-admin and alertmanager-discord applied to monitoring on $context${webhook:+ (Discord webhook set)}"
