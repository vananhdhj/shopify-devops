#!/bin/sh
# Creates (or re-passwords) the database identities and the schemas they own.
# Runs as the superuser on every start, so it must stay idempotent.
set -eu

psql -v ON_ERROR_STOP=1 \
  -v migrator_password="$DB_MIGRATOR_PASSWORD" \
  -v catalog_password="$DB_CATALOG_PASSWORD" \
  -v order_password="$DB_ORDER_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE migrator LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') \gexec
SELECT 'CREATE ROLE catalog_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalog_app') \gexec
SELECT 'CREATE ROLE order_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'order_app') \gexec

ALTER ROLE migrator PASSWORD :'migrator_password';
ALTER ROLE catalog_app PASSWORD :'catalog_password';
ALTER ROLE order_app PASSWORD :'order_password';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS catalog AUTHORIZATION migrator;
CREATE SCHEMA IF NOT EXISTS orders AUTHORIZATION migrator;
SQL
