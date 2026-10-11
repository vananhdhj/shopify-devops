# Spec: Phase 2 — the control plane

**Status:** resolved (2026-10-11: tickets 01–05 resolved; PRs #21, #22, #23 merged and deployed to the lab cluster)

Background: the blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`, revised 2026-10-11) puts Phase 2 after tenancy inside one cell: "Control plane: registry, signup, lifecycle workflows, router reading the registry, suspension and deletion", with the exit gate "Sign up a shop and buy from it with no manual step; delete it and show zero rows; crash drill passes." Phase 1 (`.scratch/phase-1-tenancy/`) is resolved. Vocabulary is in `CONTEXT.md`; ADRs 0001–0012 are binding.

## Problem Statement

Shops exist only because someone edited `deploy/base/tenants.json`, generated a password into `.secrets/dev.env`, and redeployed. A platform that serves many businesses cannot work that way: a merchant must be able to sign up and get a working shop in seconds, an operator must be able to suspend or delete a shop without a deployment, and deleting a shop must provably remove its data. Today there is no record of which shops exist apart from a file in Git, no lifecycle, and no audit of who did what to a shop.

## Solution

A **control plane** beside the cell: a tenant registry in its own database, a `platform` API, and a lifecycle worker.

- A merchant opens `shop.localhost` (the bare platform address), signs up with a handle, a shop name, and a password, and is redirected to their shop's sign-in page once it is ready, a few seconds later. No operator step and no deployment.
- The router reads its routing table from the control plane instead of a file, keeps a cached copy, and keeps serving buyers from that cache when the control plane is down.
- Merchant passwords live in the control plane, hashed. The storefront asks the control plane to check a sign-in.
- The platform operator suspends, reinstates, and deletes shops through the control plane, with an operator credential and an audit trail. Deletion removes every row of the shop from the cell and records the verification.

## User Stories

### Merchant

1. As a prospective merchant, I sign up at the platform address with a handle, a shop name, and a password, and get a working shop at `<handle>.shop.localhost` without anyone's help.
2. As a merchant, a retried or double-submitted signup gives me one shop, and a taken handle is refused with a clear message.
3. As a merchant, I sign in to my new shop with the password I chose, add a product, and a buyer can buy it.

### Guest buyer

4. As a Guest buyer, a shop being set up shows "being set up", a suspended shop shows "temporarily unavailable", and a deleted or unknown shop shows the same "no shop here" as any other unknown address.
5. As a Guest buyer, shops keep working while the control plane is down.

### Platform operator

6. As the platform operator, I list shops with their status and cell, and see each shop's lifecycle history.
7. As the platform operator, I suspend and reinstate a shop; suspension stops buyer and merchant traffic at the router and changes no shop data; Pending orders still settle.
8. As the platform operator, I delete a shop; afterwards the cell holds no row of it, and the control plane keeps an audit record of the deletion and its verification.
9. As the platform operator, every lifecycle action records who did it and when.
10. As the platform operator, a crash of the lifecycle worker mid-provisioning or mid-deletion resumes on restart without duplicating anything.

### Reviewer

11. As a reviewer, I can watch the signup-to-first-order path and the delete-to-zero-rows path in tests and on the lab cluster.

## Implementation Decisions

### Units and data

- New app `apps/platform`, one image with two processes: `platform-api` and `platform-worker` (lifecycle workflows, ops on :8102). One image keeps the build and the delivery dance to a single new unit.
- `platform-api` has two listeners. The public one (:8100) serves only the signup pages and `POST /signups`, and is the only part the router forwards from the bare platform address. The internal one (:8101) serves the router, the storefront, the cells, and the operator (`/internal/*`, `/operator/*`) plus health and metrics, and is never behind the ingress.
- Its own PostgreSQL database `platform` (Compose: a separate `platform-db` service; cluster: its own StatefulSet in the control-plane namespace), with its own roles: `platform_migrator` owns the schema, `platform_app` is the runtime identity. The control plane never shares a database with a cell, so a cell failure cannot take the registry down, and the registry does not depend on any cell.
- Registry tables (schema `platform`):
  - `tenants`: id, handle (unique, DNS label), name, status (`PROVISIONING`, `ACTIVE`, `SUSPENDED`, `DELETING`, `DELETED`), cell, merchant password hash, credential version, created_at, updated_at.
  - `signups`: idempotency key (unique) → tenant id, plus a request hash (handle, name), the same retry rule as Checkout (ADR-0001's pattern): same key and request returns the same tenant; same key, different request is refused.
  - `tenant_events`: append-only lifecycle audit: tenant id, from and to status, step, actor (`signup`, `operator`, `platform-worker`), detail (JSON), at.
  - `lifecycle_outbox`: one event per lifecycle request (provision, delete), written in the same transaction as the status change; the worker claims with `FOR UPDATE SKIP LOCKED`.
- A database trigger enforces legal tenant status transitions, as `orders_status_transition` does for Orders.
- Handles are unique forever: a deleted shop's handle is not reused in this phase (its row stays as the audit anchor).

### Lifecycle

- **Signup** (`POST /signups`, public through the router at the bare address): validates handle (DNS label, 3–30 characters, not reserved: `www`, `admin`, `api`, `platform`, `shop`), name, and password (at least 12 characters); hashes the password (scrypt); creates the tenant `PROVISIONING`, the signup record, a `tenant_events` row, and a `provision` outbox event in one transaction; answers `202` with the tenant id and a status URL.
- **Provisioning** (platform-worker), idempotent steps keyed by tenant id: place the tenant in a cell (Phase 2 has one cell, `cell-1`); mark it `ACTIVE`; then check it through the router (`GET /` at the shop's address answers 200 with the shop name) and record the result. A failed check is retried with backoff and recorded; it does not undo the activation. Nothing has to be created in the cell: pooled tenancy (ADR-0010) creates a shop's rows on its first write.
- **Suspend / reinstate** (operator): `ACTIVE ↔ SUSPENDED`, router-only effect; data untouched; Pending orders still settle.
- **Delete** (operator): `ACTIVE | SUSPENDED → DELETING` stops routing at once; the worker purges the shop in the cell, then verifies that every tenant-owned table has zero rows for it, and only then marks it `DELETED`, recording the per-table counts in `tenant_events`.

### The cell side of deletion

- Each cell schema gets a narrow function, `catalog.purge_tenant(uuid)` and `orders.purge_tenant(uuid)`, `SECURITY DEFINER` owned by the migration identity (the ADR-0012 pattern), that deletes the tenant's rows in dependency order and returns the remaining count per table. Runtime identities still have no general `DELETE`.
- Both APIs expose `POST /internal/tenants/:tenantId/purge`, refused without a new per-cell `PLATFORM_CELL_TOKEN` and outside any tenant context (like the Inventory-effect route). The order service purges first, so no Order can reference a product being deleted; the catalog follows.
- Queue jobs for a purged Order find no Order and finish as already settled.

### Router

- With `PLATFORM_API_URL` set, the router loads its routing table from `GET /internal/routes` (guarded by `PLATFORM_ROUTER_TOKEN`) at start and then every 2 seconds, keeping the last good table in memory. Without it (Phase 1 behaviour), it still reads the static file; that mode exists only so ticket 01 can merge before the cluster runs a control plane, and ticket 05 removes it.
- Readiness waits for the first table. After that, a control-plane outage leaves the router serving its cached table; a metric records the table's age.
- Status pages, all fixed bodies: `PROVISIONING` → 503 "This shop is being set up"; `SUSPENDED` → 503 "This shop is temporarily unavailable"; `DELETING`, `DELETED`, unknown → the existing 404 "No shop at this address". The bare base domain routes to the control plane's public signup pages instead of 404.
- The tenant context gains the shop's credential version (`cv`).

### Merchant credentials and sessions

- The storefront checks a sign-in by calling `POST /internal/merchant-sign-ins` on the control plane (tenant id, password; guarded by `PLATFORM_STOREFRONT_TOKEN`), which answers yes or no; the hash never leaves the control plane.
- The session signature covers tenant id, expiry, and the credential version from the tenant context, replacing the password hash. Changing a password bumps the version, which signs that shop's sessions out within one routing refresh.
- Harbor Goods and Meadow Supply are seeded into the registry with their current `MERCHANT_PASSWORD_<HANDLE>` hashes, so nothing changes for them. `MERCHANT_CREDENTIALS` and `deploy/base/tenants.json` are retired.
- A control-plane outage blocks new Merchant sign-ins and signups only; buyers and existing sessions keep working.

### Operator access

- Operator endpoints (`GET /operator/tenants`, `GET /operator/tenants/:id/events`, `POST /operator/tenants/:id/suspend|reinstate|delete`) require `PLATFORM_OPERATOR_TOKEN`; they are reached only through `make tenant` targets and port-forward, never through the ingress. `make tenant-list`, `make tenant-suspend HANDLE=…`, `make tenant-reinstate HANDLE=…`, `make tenant-delete HANDLE=…`.
- Every operator action writes a `tenant_events` row with actor `operator`.

### Secrets

- New: `DB_PLATFORM_SUPERUSER_PASSWORD`, `DB_PLATFORM_MIGRATOR_PASSWORD`, `DB_PLATFORM_APP_PASSWORD`, `PLATFORM_ROUTER_TOKEN`, `PLATFORM_STOREFRONT_TOKEN`, `PLATFORM_CELL_TOKEN`, `PLATFORM_OPERATOR_TOKEN`. Learned in Phase 1: `make secrets` must reach the cluster before Argo CD syncs a release that reads a new key; the delivery checklist says so.

### Delivery

- Same two-step merge as Phase 1: ticket 01 ships the `platform` image (and Compose wiring) on its own, with the router still in static mode in the cluster; tickets 02–05 merge together once its digest is on `main`.
- Cluster: the control plane runs in its own namespace, `platform-dev`, as its own Argo CD Application, so it syncs and fails independently of the cell. The router reaches it at `platform-api.platform-dev`.

## Testing Decisions

- Same standard as before: public seams only (HTTP, process lifecycle, database end state).
- Seam 1 (Compose) covers:
  - signup → `PROVISIONING` → `ACTIVE` within 10 s, then Merchant sign-in, add a product, a buyer Checkout reaches Confirmed: no step outside the shop's own pages
  - signup retries: 20 concurrent signups with one idempotency key create one tenant; the same key with a different handle is refused; a taken handle, an invalid handle, a reserved handle, and a short password are refused
  - status pages for provisioning, suspended, deleted, and unknown shops; suspension keeps data and lets a Pending order settle
  - deletion: a shop with Carts, Orders (one still Pending), and Inventory effects ends with zero rows in all eight tenant-owned tables, `DELETED` in the registry, and the counts in `tenant_events`; the other shop is untouched
  - crash drill: killing `platform-worker` mid-provisioning and mid-deletion resumes with one tenant, one set of events per step, and zero leftovers
  - control-plane outage: with `platform-api` stopped, existing shops serve buyers and existing sessions; signup and sign-in fail cleanly; both work again after restart
  - operator endpoints refuse without the operator token, and every action is in `tenant_events`
  - the cell's purge endpoints refuse without the cell token; runtime identities still cannot `DELETE` outside the purge functions
  - all Phase 0 and Phase 1 tests still pass
- Seam 2 (lab cluster): `make smoke` adds a signup-to-Confirmed-order path for a throwaway shop and deletes it again, checking zero rows.

## Out of Scope

- More than one cell, placement by plan or capacity, and moving tenants between cells (Phases 3 and 6).
- Plans and quotas beyond a single default plan (Phase 5).
- Email, signup verification, password reset, staff accounts, merchant billing.
- Reusing a deleted shop's handle; exporting a shop's data before deletion (blueprint mentions it; not needed for the exit gate).
- Tenant labels in metrics (Phase 5).

## Further Notes

- **Verify during implementation:** that `SKIP LOCKED` claiming on the lifecycle outbox stays correct with two platform-worker replicas; how long the router's 2-second refresh takes to pick up a new tenant in practice; Argo CD ordering between the `platform-dev` and `shop-dev` Applications on a fresh cluster (the router must not depend on the control plane being up first, beyond its readiness).
- **Steps only the author can perform:** merging ticket 01 before tickets 02–05; running `make secrets` against the cluster before the second merge syncs.
