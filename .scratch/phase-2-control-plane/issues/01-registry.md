# 01: Registry — the control plane's database, and a router that reads it

**What to build:** A new app, `apps/platform`, with its own PostgreSQL database holding the tenant registry, seeded with Harbor Goods and Meadow Supply. `platform-api` serves the routing table to the router; with `PLATFORM_API_URL` set, the router loads that table at start, refreshes it every 2 seconds, and keeps serving its cached copy when the control plane is down. This ticket ships the `platform` image on its own (see the spec's Delivery section): Compose runs the router in registry mode, the lab cluster stays in static mode until ticket 05.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] `platform` database with `platform_migrator` and `platform_app`; migrations for `tenants`, `signups`, `tenant_events`, `lifecycle_outbox`, and the tenant status-transition trigger
- [ ] Seed: Harbor Goods and Meadow Supply as `ACTIVE` in `cell-1`, with their current Merchant password hashes
- [ ] `platform-api`: `GET /internal/routes` (handle, tenant id, name, status, credential version) refused without `PLATFORM_ROUTER_TOKEN`; liveness, readiness, metrics on its ops port; structured logs
- [ ] Router registry mode: load at start (ready only after the first table), refresh every 2 s, keep the last good table on failure, expose the table's age as a metric; static mode unchanged when `PLATFORM_API_URL` is unset
- [ ] Router status pages: `PROVISIONING` and `SUSPENDED` answer 503 with fixed bodies; `DELETING`, `DELETED`, and unknown answer the existing 404
- [ ] `make secrets` generates the platform database passwords and `PLATFORM_ROUTER_TOKEN`; Compose runs `platform-db`, its role and migration jobs, and `platform-api`
- [ ] CI and release build the `platform` image for both architectures
- [ ] Seam-1 tests: the router serves both shops from the registry; a status changed directly in the registry shows the right page within the refresh interval; with `platform-api` stopped, both shops keep serving; `GET /internal/routes` refuses without the token; the transition trigger refuses an illegal status change

## Comments
