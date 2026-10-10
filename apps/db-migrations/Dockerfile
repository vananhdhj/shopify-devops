# syntax=docker/dockerfile:1
# Build context: repository root. Runs the database step of a release inside the cluster:
# PostgreSQL client tools (psql, pg_isready) plus dbmate, the repo's db/ folder, and two scripts.
FROM ghcr.io/amacneil/dbmate:2@sha256:520c740c6e0ad73fde2cd1ea7e2b779aaf789d22aca8858f87a478e7094535fb AS dbmate

FROM postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
COPY --from=dbmate /usr/local/bin/dbmate /usr/local/bin/dbmate
COPY db /db
COPY apps/db-migrations/migrate.sh apps/db-migrations/seed.sh /usr/local/bin/
USER postgres
ENTRYPOINT []
CMD ["migrate.sh"]
