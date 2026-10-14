#!/usr/bin/env bash
# Renders every manifest the repository deploys into one directory, one file per Application:
# each cell, the control plane and the edge (dev and staging), the monitoring config, and the lean
# logging charts with this repository's values (Phase 7; versions from the monitoring Application).
# CI's schema check and the manifest policies (scripts/policy.sh) both read it. The
# kube-prometheus-stack chart is not rendered: its defaults are upstream's (ADR on decision 4).
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

# The chart version the monitoring Application pins for <chart>.
version_of() { awk -v chart="$1" '$1 == "chart:" && $2 == chart { getline; print $2 }' deploy/monitoring/application.yaml; }
for chart in loki alloy; do
  helm template "$chart" "$chart" --repo https://grafana.github.io/helm-charts --version "$(version_of "$chart")" \
    --namespace monitoring --values "deploy/monitoring/${chart}-values.yaml" >"$out/${chart}.yaml"
done
