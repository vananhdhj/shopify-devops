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
add_if_missing TENANT_CONTEXT_SECRET
add_if_missing DB_PLATFORM_SUPERUSER_PASSWORD
add_if_missing DB_PLATFORM_MIGRATOR_PASSWORD
add_if_missing DB_PLATFORM_APP_PASSWORD
add_if_missing PLATFORM_ROUTER_TOKEN
add_if_missing PLATFORM_STOREFRONT_TOKEN
add_if_missing PLATFORM_CELL_TOKEN
add_if_missing PLATFORM_OPERATOR_TOKEN
add_if_missing GRAFANA_ADMIN_PASSWORD

# The Merchant passwords of the two shops seeded in Phase 1, readable enough to type, as
# MERCHANT_PASSWORD_<HANDLE>. Shops that sign up choose their own password at the control plane;
# these two are entered into its registry by the platform seed, which reads only their scrypt
# hashes, from MERCHANT_CREDENTIALS (`<tenant id>=<hash>,...`). Existing hashes are kept, so
# re-running changes nothing. To change one: edit its password line, delete MERCHANT_CREDENTIALS,
# re-run, and bump the shop's credential version in the registry.
# shellcheck disable=SC2016 # JavaScript template literals, not shell
SECRETS_FILE="$file" node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { randomBytes, scryptSync } = require("node:crypto");
  const file = process.env.SECRETS_FILE;
  const seeded = [
    { id: "10000000-0000-4000-8000-000000000001", handle: "harbor" },
    { id: "10000000-0000-4000-8000-000000000002", handle: "meadow" },
  ];
  let lines = readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
  const value = (key) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

  const credentials = new Map(
    (value("MERCHANT_CREDENTIALS") ?? "").split(",").filter(Boolean).map((entry) => entry.split("=")),
  );
  for (const shop of seeded) {
    const key = `MERCHANT_PASSWORD_${shop.handle.toUpperCase()}`;
    if (value(key) === undefined) lines.push(`${key}=${randomBytes(18).toString("base64url").replace(/[-_]/g, "")}`);
    if (!credentials.has(shop.id)) {
      const salt = randomBytes(16);
      const hash = scryptSync(value(key), salt, 32);
      credentials.set(shop.id, `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`);
    }
  }

  lines = lines.filter((line) => !line.startsWith("MERCHANT_CREDENTIALS="));
  lines.push(`MERCHANT_CREDENTIALS=${[...credentials].map(([id, hash]) => `${id}=${hash}`).join(",")}`);
  writeFileSync(file, `${lines.join("\n")}\n`);
'
add_if_missing REDIS_PASSWORD
