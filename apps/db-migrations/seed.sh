#!/bin/sh
# Dev-only: resets the seed products to their seed price and Stock (and checks all 12 exist).
set -eu
: "${PGHOST:?}" "${DB_MIGRATOR_PASSWORD:?}"
PGUSER=migrator PGPASSWORD="$DB_MIGRATOR_PASSWORD" PGDATABASE=shop \
  psql -v ON_ERROR_STOP=1 -f /db/seed/catalog.sql
