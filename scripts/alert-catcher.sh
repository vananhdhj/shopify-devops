# shellcheck shell=bash
# Shared by the drills: what the lab's in-cluster alert catcher has received in the last 30 minutes.
# Usage: source scripts/alert-catcher.sh; caught <alertname> <firing|resolved>  -> one JSON line per notification
# Reads CONTEXT and NAMESPACE like the Makefile (defaults: k3d-shop, shop-dev).

caught() {
  kubectl --context "${CONTEXT:-k3d-shop}" -n monitoring logs deploy/alert-catcher --since=30m 2>/dev/null |
    jq -c --arg a "$1" --arg s "$2" --arg ns "${NAMESPACE:-shop-dev}" \
      'select(.alertname==$a and .status==$s and .namespace==$ns)' 2>/dev/null || true
}

caught_count() {
  caught "$1" "$2" | wc -l | tr -d ' '
}
