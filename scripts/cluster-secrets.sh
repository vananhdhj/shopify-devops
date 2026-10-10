#!/usr/bin/env bash
# Copies .secrets/dev.env into the cluster as the `shop-secrets` Secret, when the lab cluster is
# reachable. Secrets never live in Git; Argo CD applications only reference them by name.
# The Merchant's plaintext password stays local: the cluster needs only its hash.
# Pods read secrets at startup, so after rotating a value, restart the affected Deployments.
set -euo pipefail

context="$1"
namespace="$2"

if ! kubectl --context "$context" get --raw /readyz >/dev/null 2>&1; then
  echo "cluster context $context not reachable; skipping Kubernetes secrets"
  exit 0
fi

kubectl --context "$context" create namespace "$namespace" --dry-run=client -o yaml |
  kubectl --context "$context" apply -f - >/dev/null
grep -v '^ADMIN_PASSWORD=' .secrets/dev.env |
  kubectl --context "$context" -n "$namespace" create secret generic shop-secrets \
    --from-env-file=/dev/stdin --dry-run=client -o yaml |
  kubectl --context "$context" -n "$namespace" label --local -f - app.kubernetes.io/part-of=shop -o yaml |
  kubectl --context "$context" apply -f - >/dev/null
echo "secret shop-secrets applied to $namespace on $context"

# The monitoring namespace: Grafana's admin login, and the Discord webhook Alertmanager reads
# from a mounted file. Without a webhook in .secrets/dev.env, a placeholder keeps Alertmanager
# running (Discord deliveries fail, the in-cluster alert catcher still receives every alert).
value() { grep "^$1=" .secrets/dev.env | cut -d= -f2-; }
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
