#!/usr/bin/env bash
# Renders every manifest the repository deploys into one directory, one file per Application:
# each cell, the control plane and the edge (dev and staging), and the monitoring config. CI's
# schema check and the manifest policies (scripts/policy.sh) both read it.
#   render-manifests.sh <dir>
set -euo pipefail
out="${1:?usage: render-manifests.sh <dir>}"
rm -rf "$out" && mkdir -p "$out"
for cell in deploy/cells/dev/*/ deploy/cells/staging/*/; do
  env="$(basename "$(dirname "$cell")")"
  kubectl kustomize "$cell" >"$out/cell-${env}-$(basename "$cell").yaml"
done
for overlay in dev staging; do
  kubectl kustomize "deploy/platform/overlays/${overlay}" >"$out/platform-${overlay}.yaml"
  kubectl kustomize "deploy/edge/overlays/${overlay}" >"$out/edge-${overlay}.yaml"
done
kubectl kustomize deploy/monitoring/config >"$out/monitoring.yaml"
