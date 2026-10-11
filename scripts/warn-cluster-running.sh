#!/usr/bin/env bash
# Warns (never fails) when the k3d lab cluster runs beside the Compose stack: both share the Colima
# VM's 6 CPUs, and together with image builds they saturate it (load average 35-45 in Phase 2),
# which makes timing-sensitive tests fail and pass again on a re-run.
set -euo pipefail

cluster="${1:-shop}"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "k3d-${cluster}-server-0"; then
  {
    echo "WARNING: the k3d cluster '${cluster}' is running beside the Compose stack; tests may time out under load."
    echo "         For a reliable run: k3d cluster stop ${cluster}   (afterwards: k3d cluster start ${cluster})"
  } >&2
fi
