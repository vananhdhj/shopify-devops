#!/usr/bin/env bash
# Prepares the lab cluster for its Secrets, which come from Git as SealedSecrets since Phase 7
# (ticket 04; `scripts/seal-secrets.py` seals them, the controller decrypts them). When the cluster
# is reachable, this:
#   - creates the namespaces the Secrets live in (no Application creates its namespace);
#   - on a fresh cluster, restores the controller's sealing key from the backup in .secrets/
#     (`make seal-key-backup`), before the controller starts, so it can decrypt what Git holds;
#   - marks Secrets that `kubectl` created before the switch as managed by the controller, which
#     then takes them over (it refuses to overwrite a Secret it does not manage).
# It writes no Secret itself. Pods read secrets at startup: after a value changes, restart them.
set -euo pipefail

context="$1"
platform_namespace="$2"
edge_namespace="$3"

if ! kubectl --context "$context" get --raw /readyz >/dev/null 2>&1; then
  echo "WARNING: cluster context $context not reachable; its namespaces and sealing key were NOT prepared." >&2
  echo "         Re-run make secrets once it is reachable." >&2
  exit 0
fi

namespaces=(monitoring "$platform_namespace" "$edge_namespace")
for cell_json in deploy/cells/dev/*/cell.json; do
  namespaces+=("$(sed -n 's/.*"namespace": *"\([^"]*\)".*/\1/p' "$cell_json")")
done
for namespace in "${namespaces[@]}"; do
  kubectl --context "$context" create namespace "$namespace" --dry-run=client -o yaml |
    kubectl --context "$context" apply -f - >/dev/null
done
echo "namespaces ready on $context: ${namespaces[*]}"

# The sealing key: restored only into a cluster that has none (a rebuilt cluster), never over one.
backup=.secrets/sealed-secrets-key.yaml
if [ -s "$backup" ] && [ -z "$(kubectl --context "$context" -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o name)" ]; then
  kubectl --context "$context" apply -f "$backup" >/dev/null
  echo "sealing key restored from $backup into kube-system (the controller reads it when it starts)"
fi

# Secrets from before the switch: handed to the controller, which rewrites them from Git.
for pair in shop-dev/shop-secrets cell-canary-dev/shop-secrets cell-dedicated-1-dev/shop-secrets \
  "$platform_namespace/platform-secrets" "$platform_namespace/cell-credentials" \
  "$edge_namespace/edge-secrets" "$edge_namespace/cell-credentials" monitoring/grafana-admin monitoring/alertmanager-discord; do
  if kubectl --context "$context" -n "${pair%%/*}" get secret "${pair##*/}" >/dev/null 2>&1; then
    kubectl --context "$context" -n "${pair%%/*}" annotate secret "${pair##*/}" --overwrite \
      sealedsecrets.bitnami.com/managed=true >/dev/null
  fi
done
echo "existing Secrets marked as managed by the Sealed Secrets controller"
