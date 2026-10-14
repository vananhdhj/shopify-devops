#!/usr/bin/env bash
# The Sealed Secrets controller's private keys (Phase 7, ticket 04): the only thing that decrypts
# the SealedSecrets in Git. Backed up to .secrets/ (never Git, mode 600); restored into a cluster
# that lost them, then the controller restarted to read them.
#   seal-key.sh backup <context>
#   seal-key.sh restore <context>
set -euo pipefail
action="${1:?usage: seal-key.sh backup|restore <context>}"
context="${2:?usage: seal-key.sh backup|restore <context>}"
backup=.secrets/sealed-secrets-key.yaml
case "$action" in
  backup)
    umask 077
    kubectl --context "$context" -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o json |
      jq '{apiVersion: "v1", kind: "List", items: [.items[] | {apiVersion, kind, type, data,
            metadata: {name: .metadata.name, namespace: .metadata.namespace, labels: .metadata.labels}}]}' >"$backup"
    echo "$(jq '.items | length' "$backup") sealing key(s) backed up to $backup" ;;
  restore)
    [ -s "$backup" ] || { echo "no backup at $backup" >&2; exit 1; }
    kubectl --context "$context" apply -f "$backup" >/dev/null
    kubectl --context "$context" -n kube-system rollout restart deploy/sealed-secrets-controller >/dev/null
    kubectl --context "$context" -n kube-system rollout status deploy/sealed-secrets-controller --timeout=180s >/dev/null
    echo "sealing key(s) restored from $backup; the controller restarted" ;;
  *)
    echo "unknown action '$action' (backup, restore)" >&2; exit 2 ;;
esac
