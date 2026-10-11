#!/bin/sh
# The control plane's database step, run before new control-plane pods start (an Argo CD PreSync
# hook in the platform namespace): (re)create its identities and schema, apply its migrations as
# its migrator, then enter the seeded shops into the registry if they are missing. Safe to re-run.
set -eu
: "${PGHOST:?}" "${DB_PLATFORM_SUPERUSER_PASSWORD:?}" "${DB_PLATFORM_MIGRATOR_PASSWORD:?}" "${MERCHANT_CREDENTIALS:?}"

until pg_isready -h "$PGHOST" -U postgres -d platform -q; do
  echo "waiting for PostgreSQL at $PGHOST"
  sleep 2
done

PGUSER=postgres PGPASSWORD="$DB_PLATFORM_SUPERUSER_PASSWORD" PGDATABASE=platform sh /db/platform/roles.sh

dbmate \
  --url "postgres://platform_migrator:${DB_PLATFORM_MIGRATOR_PASSWORD}@${PGHOST}:5432/platform?sslmode=disable" \
  --migrations-dir /db/platform/migrations \
  --migrations-table platform.schema_migrations \
  --no-dump-schema \
  --wait \
  up

PGUSER=platform_migrator PGPASSWORD="$DB_PLATFORM_MIGRATOR_PASSWORD" PGDATABASE=platform sh /db/platform/seed.sh
