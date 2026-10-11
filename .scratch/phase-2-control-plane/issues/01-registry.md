# 01: Registry — the control plane's database, and a router that reads it

**What to build:** A new app, `apps/platform`, with its own PostgreSQL database holding the tenant registry, seeded with Harbor Goods and Meadow Supply. `platform-api` serves the routing table to the router; with `PLATFORM_API_URL` set, the router loads that table at start, refreshes it every 2 seconds, and keeps serving its cached copy when the control plane is down. This ticket ships the `platform` image on its own (see the spec's Delivery section): Compose runs the router in registry mode, the lab cluster stays in static mode until ticket 05.

**Blocked by:** none

**Status:** resolved

- [x] `platform` database with `platform_migrator` and `platform_app`; migrations for `tenants`, `signups`, `tenant_events`, `lifecycle_outbox`, and the tenant status-transition trigger
- [x] Seed: Harbor Goods and Meadow Supply as `ACTIVE` in `cell-1`, with their current Merchant password hashes
- [x] `platform-api`: `GET /internal/routes` (handle, tenant id, name, status, credential version) refused without `PLATFORM_ROUTER_TOKEN`; liveness, readiness, metrics on its ops port; structured logs
- [x] Router registry mode: load at start (ready only after the first table), refresh every 2 s, keep the last good table on failure, expose the table's age as a metric; static mode unchanged when `PLATFORM_API_URL` is unset
- [x] Router status pages: `PROVISIONING` and `SUSPENDED` answer 503 with fixed bodies; `DELETING`, `DELETED`, and unknown answer the existing 404
- [x] `make secrets` generates the platform database passwords and `PLATFORM_ROUTER_TOKEN`; Compose runs `platform-db`, its role and migration jobs, and `platform-api`
- [x] CI and release build the `platform` image for both architectures
- [x] Seam-1 tests: the router serves both shops from the registry; a status changed directly in the registry shows the right page within the refresh interval; with `platform-api` stopped, both shops keep serving; `GET /internal/routes` refuses without the token; the transition trigger refuses an illegal status change

## Comments

Implementation notes (2026-10-11):
- `platform-api` has two listeners (spec updated): the internal one (:8101) serves `/internal/routes`, health, and metrics; the public signup listener (:8100) arrives in ticket 03.
- The router's route source is pluggable: registry mode (loads at start, ready only after the first table, refreshes every 2 s, keeps the last good table on failure; gauge `router_routes_age_seconds`, counter `router_routes_refresh_failures_total`) or the Phase 1 static file. Ticket 02 removes static mode.
- The seed inserts the two Phase 1 shops as `PROVISIONING` and then activates them (the trigger allows nothing else), recording both steps; it only adds what is missing, so it never undoes a later suspension or deletion.
- The router's image now copies `@shop/contracts` (type-only) for the routing-table types.

Resolved 2026-10-11 with PR #21 (`dbd417a`). CI passed the full suite on amd64 and arm64. The local `make test` was stopped by its 30-minute background limit while Vitest was starting (the image builds took most of it), so the local run is inconclusive; CI is the evidence. New tests: the routing table refuses callers without the token; a shop's page follows its registry status through provisioning, active, suspended, deleting, and deleted; the trigger refuses illegal moves; the seed recorded its events; with `platform-api` stopped, both shops keep serving and the router stays ready.
