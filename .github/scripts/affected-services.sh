#!/usr/bin/env bash
# Turns dorny/paths-filter's list of changed filter names into what CI should run.
#   $1: JSON array of changed filters, e.g. ["worker","tests"]
#   $2: "true" to treat every service as affected (manual full build)
#   $3: "ci" (default) or "release": CI treats `ci-shared` (Compose, Makefile, scripts, CI config)
#       as affecting every service; a release does not, since no image holds those files
# Writes `services` (JSON array) and `integration` (true/false) to $GITHUB_OUTPUT.
set -euo pipefail

changed="$1"
force_all="${2:-false}"
mode="${3:-ci}"
all='["catalog-cart-api","order-service","worker","storefront","router","platform","db-migrations"]'

if [[ "$force_all" == "true" ]] || jq -e 'index("shared")' <<<"$changed" >/dev/null ||
  { [[ "$mode" == ci ]] && jq -e 'index("ci-shared")' <<<"$changed" >/dev/null; }; then
  services="$all"
else
  services="$(jq -c --argjson all "$all" '[.[] | select(. as $f | $all | index($f))]' <<<"$changed")"
fi

# The integration suite exercises every service together, so any code or test change runs it.
if [[ "$services" != "[]" ]] || jq -e 'index("tests")' <<<"$changed" >/dev/null; then
  integration=true
else
  integration=false
fi

echo "services=$services" >>"$GITHUB_OUTPUT"
echo "integration=$integration" >>"$GITHUB_OUTPUT"
echo "affected services: $services; integration: $integration"
