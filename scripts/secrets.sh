#!/usr/bin/env bash
# Generates local development secrets. Existing values are never overwritten,
# so re-running only adds keys introduced since the last run.
#   .secrets/dev.env           the platform's own keys (control plane, operator, monitoring)
#   .secrets/cells/<cell>.env  one file per cell, the same key names in each, so a leak exposes one cell
#   .secrets/mounts/           the per-cell secrets that platform-level units hold for every cell,
#                              one file per cell and key, as the cluster mounts them from a Secret
set -euo pipefail

# The cells this laptop runs: one per directory under deploy/cells/dev (the lab cluster), the same
# ids in Compose (pool-1, and dedicated-1 with CELLS=2). Adding a cell's directory adds its secrets.
cells=()
for dir in deploy/cells/dev/*/; do cells+=("$(basename "$dir")"); done
# What every cell has of its own.
cell_keys=(
  DB_SUPERUSER_PASSWORD DB_MIGRATOR_PASSWORD DB_CATALOG_PASSWORD DB_ORDER_PASSWORD REDIS_PASSWORD
  ORDER_TOKEN_SECRET INTERNAL_INVENTORY_TOKEN ADMIN_SERVICE_TOKEN SESSION_SECRET
  TENANT_CONTEXT_SECRET PLATFORM_CELL_TOKEN PLATFORM_STOREFRONT_TOKEN
)

file=".secrets/dev.env"
mkdir -p .secrets
chmod 700 .secrets
touch "$file"
chmod 600 "$file"
# A hand-pasted last line often lacks a newline; appending to it would glue two keys together.
[ ! -s "$file" ] || [ -z "$(tail -c1 "$file")" ] || echo >>"$file"

# add_if_missing KEY [FILE]
add_if_missing() {
  local target="${2:-$file}"
  grep -q "^$1=" "$target" || echo "$1=$(openssl rand -hex 24)" >>"$target"
}

add_if_missing DB_PLATFORM_SUPERUSER_PASSWORD
add_if_missing DB_PLATFORM_MIGRATOR_PASSWORD
add_if_missing DB_PLATFORM_APP_PASSWORD
add_if_missing PLATFORM_ROUTER_TOKEN
add_if_missing PLATFORM_OPERATOR_TOKEN
add_if_missing GRAFANA_ADMIN_PASSWORD

mkdir -p .secrets/cells
for cell in "${cells[@]}"; do
  cell_file=".secrets/cells/$cell.env"
  touch "$cell_file"
  chmod 600 "$cell_file"
  for key in "${cell_keys[@]}"; do
    # Phase 2 kept pool-1's keys in .secrets/dev.env: move them, values unchanged, so the cell's
    # running database and sessions keep working.
    if [ "$cell" = pool-1 ] && ! grep -q "^$key=" "$cell_file" && grep -q "^$key=" "$file"; then
      grep "^$key=" "$file" >>"$cell_file"
    fi
    add_if_missing "$key" "$cell_file"
  done
done
# Only once every cell file has them: drop the moved keys from the platform's file.
for key in "${cell_keys[@]}"; do
  if grep -q "^$key=" "$file"; then
    grep -v "^$key=" "$file" >"$file.tmp" || true
    mv "$file.tmp" "$file"
    chmod 600 "$file"
  fi
done

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

# The per-cell secrets each platform-level unit holds: the control plane registers cells and
# checks their storefronts' sign-ins; the edge signs each cell's tenant context. Readable by the
# containers' users (the parent .secrets stays private to you).
cell_value() { grep "^$2=" ".secrets/cells/$1.env" | cut -d= -f2-; }
mkdir -p .secrets/mounts/platform .secrets/mounts/edge
chmod 755 .secrets/mounts .secrets/mounts/platform .secrets/mounts/edge
for cell in "${cells[@]}"; do
  printf '%s' "$(cell_value "$cell" PLATFORM_CELL_TOKEN)" >".secrets/mounts/platform/$cell.platform-cell-token"
  printf '%s' "$(cell_value "$cell" PLATFORM_STOREFRONT_TOKEN)" >".secrets/mounts/platform/$cell.storefront-token"
  printf '%s' "$(cell_value "$cell" TENANT_CONTEXT_SECRET)" >".secrets/mounts/edge/$cell.tenant-context-secret"
done
chmod 644 .secrets/mounts/platform/* .secrets/mounts/edge/*

# Compose reads one set of variables for the whole stack, so every cell but the default one is also
# written with its id as prefix (dedicated-1's DB_SUPERUSER_PASSWORD as DEDICATED_1_DB_SUPERUSER_PASSWORD),
# for compose.dedicated-1.yaml. Rewritten every run, from the cell files.
compose_file=".secrets/compose-cells.env"
: >"$compose_file"
chmod 600 "$compose_file"
for cell in "${cells[@]}"; do
  [ "$cell" = pool-1 ] && continue
  prefix="$(printf '%s' "$cell" | tr 'a-z-' 'A-Z_')_"
  sed "s/^/$prefix/" ".secrets/cells/$cell.env" >>"$compose_file"
done
