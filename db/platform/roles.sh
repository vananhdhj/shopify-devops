#!/bin/sh
# Creates (or re-passwords) the control plane's database identities and its schema, in its own
# database, apart from every cell's. Runs as the superuser on every start, so it must stay idempotent.
set -eu

psql -v ON_ERROR_STOP=1 \
  -v migrator_password="$DB_PLATFORM_MIGRATOR_PASSWORD" \
  -v app_password="$DB_PLATFORM_APP_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE platform_migrator LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_migrator') \gexec
SELECT 'CREATE ROLE platform_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') \gexec

ALTER ROLE platform_migrator PASSWORD :'migrator_password';
ALTER ROLE platform_app PASSWORD :'app_password';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION platform_migrator;
SQL
