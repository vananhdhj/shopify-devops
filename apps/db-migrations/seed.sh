#!/bin/sh
# Dev-only: resets a cell's seed products to their seed price and Stock (and checks they all
# exist). Each cell seeds only the shops it holds: pool-1 Harbor Goods and Meadow Supply
# (catalog.sql, the default), the canary cell the platform's synthetic shop (canary.sql).
set -eu
: "${PGHOST:?}" "${DB_MIGRATOR_PASSWORD:?}"
PGUSER=migrator PGPASSWORD="$DB_MIGRATOR_PASSWORD" PGDATABASE=shop \
  psql -v ON_ERROR_STOP=1 -f "/db/seed/${SEED_FILE:-catalog.sql}"
