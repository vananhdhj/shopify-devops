#!/bin/sh
# One release's database step, run before new application pods start (an Argo CD PreSync hook):
# (re)create the identities and schemas, then apply each schema's migrations as the migrator.
# Safe to re-run: roles.sh is idempotent and dbmate skips applied migrations.
set -eu
: "${PGHOST:?}" "${DB_SUPERUSER_PASSWORD:?}" "${DB_MIGRATOR_PASSWORD:?}"

until pg_isready -h "$PGHOST" -U postgres -d shop -q; do
  echo "waiting for PostgreSQL at $PGHOST"
  sleep 2
done

PGUSER=postgres PGPASSWORD="$DB_SUPERUSER_PASSWORD" PGDATABASE=shop sh /db/roles.sh

for schema in catalog orders; do
  echo "migrating schema $schema"
  dbmate \
    --url "postgres://migrator:${DB_MIGRATOR_PASSWORD}@${PGHOST}:5432/shop?sslmode=disable" \
    --migrations-dir "/db/${schema}/migrations" \
    --migrations-table "${schema}.schema_migrations" \
    --no-dump-schema \
    --wait \
    up
done
