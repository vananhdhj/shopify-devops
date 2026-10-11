#!/bin/sh
# Enters the Phase 1 shops into the registry if they are missing (see seed.sql). Their password
# hashes are read from MERCHANT_CREDENTIALS (`<tenant id>=<scrypt hash>,...`, from make secrets).
set -eu
: "${MERCHANT_CREDENTIALS:?}"

hash_of() {
  printf '%s' "$MERCHANT_CREDENTIALS" | tr ',' '\n' | sed -n "s/^$1=//p"
}
harbor_hash="$(hash_of 10000000-0000-4000-8000-000000000001)"
meadow_hash="$(hash_of 10000000-0000-4000-8000-000000000002)"
[ -n "$harbor_hash" ] && [ -n "$meadow_hash" ] || { echo "MERCHANT_CREDENTIALS lacks a seeded shop" >&2; exit 1; }

psql -v ON_ERROR_STOP=1 -v harbor_hash="$harbor_hash" -v meadow_hash="$meadow_hash" -f "$(dirname "$0")/seed.sql"
