#!/usr/bin/env bash
# Generates local development secrets. Existing values are never overwritten,
# so re-running only adds keys introduced since the last run.
set -euo pipefail

file=".secrets/dev.env"
mkdir -p .secrets
chmod 700 .secrets
touch "$file"
chmod 600 "$file"
# A hand-pasted last line often lacks a newline; appending to it would glue two keys together.
[ ! -s "$file" ] || [ -z "$(tail -c1 "$file")" ] || echo >>"$file"

add_if_missing() {
  grep -q "^$1=" "$file" || echo "$1=$(openssl rand -hex 24)" >>"$file"
}

add_if_missing DB_SUPERUSER_PASSWORD
add_if_missing DB_MIGRATOR_PASSWORD
add_if_missing DB_CATALOG_PASSWORD
add_if_missing DB_ORDER_PASSWORD
add_if_missing ORDER_TOKEN_SECRET
add_if_missing INTERNAL_INVENTORY_TOKEN
add_if_missing ADMIN_SERVICE_TOKEN
add_if_missing SESSION_SECRET
add_if_missing GRAFANA_ADMIN_PASSWORD

# The Merchant's password, readable enough to type; only its scrypt hash reaches the storefront.
# To change it: edit ADMIN_PASSWORD, delete the ADMIN_PASSWORD_HASH line, and re-run.
grep -q "^ADMIN_PASSWORD=" "$file" || echo "ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')" >>"$file"
if ! grep -q "^ADMIN_PASSWORD_HASH=" "$file"; then
  password="$(grep "^ADMIN_PASSWORD=" "$file" | cut -d= -f2-)"
  # shellcheck disable=SC2016 # a JavaScript template literal, not shell
  hash="$(ADMIN_PASSWORD="$password" node -e '
    const { randomBytes, scryptSync } = require("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync(process.env.ADMIN_PASSWORD, salt, 32);
    console.log(`scrypt:${salt.toString("hex")}:${key.toString("hex")}`);
  ')"
  echo "ADMIN_PASSWORD_HASH=$hash" >>"$file"
fi
add_if_missing REDIS_PASSWORD
