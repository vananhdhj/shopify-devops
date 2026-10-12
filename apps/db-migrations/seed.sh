#!/bin/sh
# Dev-only: resets a cell's seed products to their seed price and Stock (and checks they all
# exist). Only pool-1 holds seeded shops, Harbor Goods and Meadow Supply (catalog.sql, the default);
# a cell's synthetic shop gets its product from the control plane (Phase 4).
set -eu
: "${PGHOST:?}" "${DB_MIGRATOR_PASSWORD:?}"
PGUSER=migrator PGPASSWORD="$DB_MIGRATOR_PASSWORD" PGDATABASE=shop \
  psql -v ON_ERROR_STOP=1 -f "/db/seed/${SEED_FILE:-catalog.sql}"
