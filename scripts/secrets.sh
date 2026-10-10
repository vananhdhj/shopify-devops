#!/usr/bin/env bash
# Generates local development secrets. Existing values are never overwritten,
# so re-running only adds keys introduced since the last run.
set -euo pipefail

file=".secrets/dev.env"
mkdir -p .secrets
chmod 700 .secrets
touch "$file"
chmod 600 "$file"

add_if_missing() {
  grep -q "^$1=" "$file" || echo "$1=$(openssl rand -hex 24)" >>"$file"
}

add_if_missing DB_SUPERUSER_PASSWORD
add_if_missing DB_MIGRATOR_PASSWORD
add_if_missing DB_CATALOG_PASSWORD
add_if_missing DB_ORDER_PASSWORD
add_if_missing ORDER_TOKEN_SECRET
add_if_missing REDIS_PASSWORD
