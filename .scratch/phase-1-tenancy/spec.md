# Spec: Phase 1 — two shops in one cell

**Status:** ready-for-agent

Background: the revised blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`, 2026-10-11) turns the single-merchant lab into a multi-tenant commerce platform. Phase 0 (the proof of concept in `.scratch/shopify-devops-poc/`) is complete and becomes one **cell**. This spec covers Phase 1: tenancy inside that one cell. Domain vocabulary is in `CONTEXT.md` (Tenant terms are added by this phase); ADRs 0001–0009 are binding except where this spec amends 0004, 0006, and 0007.

## Problem Statement

The lab runs exactly one shop. A platform that provides software to many businesses has to keep each merchant's shop apart from every other one, on shared code and a shared database, and has to prove it. Today nothing in the data model, the services, or the edge knows that more than one shop could exist: a product, Cart, or Order belongs to "the shop", the Merchant is one password, and every query sees every row.

## Solution

Two seeded shops, **Harbor Goods** and **Meadow Supply**, run in the one cell, each at its own address (`harbor.shop.localhost`, `meadow.shop.localhost`), each with its own products, Carts, Orders, and Merchant password.

- A new **router** in front of the storefront maps the request's host to a tenant from a static tenant table and attaches a signed **tenant context** to the request. Nothing downstream trusts a tenant named by the client.
- Every tenant-owned table gets a `tenant_id`. PostgreSQL row-level security (RLS) limits each runtime identity to the tenant set for its current transaction, and a transaction with no tenant set sees and writes nothing.
- The storefront, both APIs, and the worker carry the tenant context end to end, including through the queue.
- A cross-tenant isolation suite proves, on every pull request, that no API path, credential, token, or database session reaches another tenant's data.

## User Stories

### Guest buyer

1. As a Guest buyer, I open a shop at its own address and see only that shop's products and name.
2. As a Guest buyer, my Cart, Checkout, and Order work exactly as in Phase 0, within the shop I am in.
3. As a Guest buyer, an Order link from one shop shows nothing at another shop's address.

### Merchant

4. As a Merchant, I sign in at my shop's address with my own password, and my password does not work at any other shop.
5. As a Merchant, I see and fulfill only my shop's Orders, and products I add appear only in my shop.
6. As a Merchant, my signed-in session is valid only at my shop.

### Platform operator

7. As the platform operator, I add a shop to the static tenant table and seed data, and it is served at its handle without code changes.
8. As the platform operator, every log line from a tenant's request names the tenant, so I can follow one shop's traffic.
9. As the platform operator, a request to an unknown shop address gets a plain "no shop here" response that reveals nothing about existing shops.

### Developer

10. As the developer, a new tenant-owned table without `tenant_id` or without RLS fails CI.
11. As the developer, forgetting to set the tenant in a transaction fails closed: the query sees no rows and inserts fail.
12. As the developer, the Phase 0 correctness suite still passes, now run against a tenant.

### Reviewer

13. As a reviewer, I can read the isolation suite and see each cross-tenant path attempted and refused.

## Implementation Decisions

### Tenants

- Phase 1 has a **static tenant table**, `deploy/base/tenants.json`: id (fixed UUID), handle (DNS label), display name. The router reads it; Compose mounts it; Kubernetes ships it as a ConfigMap. The control plane replaces it in Phase 2.
- Seeded tenants: `harbor` (`10000000-0000-4000-8000-000000000001`, Harbor Goods: the Phase 0 catalog) and `meadow` (`10000000-0000-4000-8000-000000000002`, Meadow Supply: a smaller, different catalog that also has one product with Stock 1).
- Existing single-shop rows are backfilled to `harbor`, the first tenant, by the migration.

### Router

- New deployment unit `apps/router` (Fastify, `@fastify/http-proxy`). It is the only unit exposed through the ingress; the storefront moves behind it.
- It takes the leftmost host label under the base domain (`TENANT_BASE_DOMAIN`, `shop.localhost`) as the handle. An unknown handle, a bare base domain, or any other host answers `404` with a fixed body, without contacting the storefront.
- It drops any client-supplied `x-tenant-context` header, adds a fresh signed one, preserves the original `Host` (the storefront's cross-site check compares Origin with Host), and proxies to the storefront.
- It has its own liveness, readiness (tenant table loaded), and metrics endpoints, and the same structured logs as the APIs, with the tenant handle on request lines.

### Tenant context

- One header, `x-tenant-context`: `base64url(JSON {tenantId, handle, name, issuedAt})` + `.` + `base64url(HMAC-SHA256(TENANT_CONTEXT_SECRET, payload))`. Valid for 60 seconds after `issuedAt`, with 5 seconds of clock skew allowed.
- `TENANT_CONTEXT_SECRET` is one secret per cell, held by the router, storefront, and both APIs. A leaked secret exposes one cell, not the platform.
- New package `@shop/tenancy`: sign, verify, header name. No dependencies beyond `node:crypto`, so the storefront can use it too.
- The storefront verifies the context on every request (`proxy.ts`) and answers `404` without it, so reaching the storefront directly, around the router, serves nothing. It forwards the same header on every backend call.
- Both APIs verify the context on every business route through a shared Fastify hook in `@shop/service-kit`; health and metrics routes are exempt. A missing, malformed, expired, or wrongly signed context answers `401 tenant_context_required`.
- The order service forwards the incoming context when it reads a Cart from the catalog.
- The internal Inventory-effect endpoint is the one exception: the worker has no shop request to carry a context from, and it knows only a tenant id, not a handle or name. Its body names the tenant (`tenantId`), and the internal token, which only the worker holds, is what makes that claim trusted. The endpoint sets that tenant for its transaction like any other.

### Data model and RLS

- Every one of the eight tables gets `tenant_id uuid NOT NULL`, defaulting to the transaction's tenant, so inserts need no change and an insert with no tenant set fails.
- Each schema defines `current_tenant()`: `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. An unset tenant is `NULL` and matches nothing.
- RLS is enabled on every table, with one policy per runtime identity: `USING` and `WITH CHECK` both `tenant_id = current_tenant()`. Runtime identities never own tables and do not have `BYPASSRLS`. RLS is enabled but not forced: the migration identity owns the tables and works across tenants for migrations, seeding, and test assertions.
- Tenant-scoped keys: `(tenant_id, id)` is unique on products, carts, and orders; foreign keys become composite, so a Cart line can only name a product of the same tenant and an Order's items, outbox events, and status history can only belong to an Order of the same tenant. The Checkout key and source Cart ID become unique per tenant; Inventory effects are keyed by `(tenant_id, order_id, action)`.
- Services run every business query in a transaction that first sets the tenant (`set_config('app.tenant_id', $1, true)`), through `withTenant(db, tenantId, work)` in `@shop/service-kit`.
- **Cross-tenant work goes through narrow functions, not table access.** The worker's dispatcher and reconciliation, and the oldest-Pending gauge, scan every tenant. They call `SECURITY DEFINER` functions owned by the migration identity that return only ids and timestamps: claim a batch of undispatched outbox events (with `FOR UPDATE SKIP LOCKED`), mark events dispatched, requeue stale Pending orders, and report the oldest Pending age. The order identity loses its direct `SELECT` and `UPDATE` on the outbox.
- A schema test lists every table in `catalog` and `orders` (except the migration tables) and fails unless it has a non-null `tenant_id` and RLS enabled with policies.

### Order tokens, Merchant credentials, sessions

- The Order token becomes `HMAC(ORDER_TOKEN_SECRET, tenantId + ":" + orderId)` (amends ADR-0004). Phase 0 Order links stop working; the dev lab accepts that.
- Each tenant has its own Merchant password. `make secrets` generates `MERCHANT_PASSWORD_<HANDLE>` for every tenant in the tenant table and assembles `MERCHANT_PASSWORD_HASHES` (`<tenantId>=<scrypt hash>,…`) for the storefront. `ADMIN_PASSWORD` and `ADMIN_PASSWORD_HASH` are retired.
- The Merchant session signature covers the tenant id, so a session cookie copied to another shop's address is invalid there.
- The admin service token stays one per cell (ADR-0007 holds within a cell); the tenant comes from the tenant context, never from the token.

### Observability

- Every API, worker, router, and storefront log line for tenant work carries `tenantId`. The queue job carries `tenantId`.
- Metrics keep their Phase 0 labels; the tenant dimension in metrics is Phase 5. The oldest-Pending gauge stays cell-wide.

### Delivery

- The router is a new image. Its first build must land on `main` before any manifest references it, because every workload image is pinned by digest and the digest exists only after the release build. So ticket 01 merges on its own; tickets 02–04 merge together in a second pull request.
- The release job that writes digests into the dev overlay adds an image entry when the overlay has none for that image yet.
- In the lab cluster, the Ingress routes `*.shop.localhost` to the router. The Phase 1 rollout breaks old pods for its duration (RLS starts refusing tenant-less queries before the new pods are up); the dev lab accepts this, and expand/contract migrations arrive in Phase 4.

## Testing Decisions

- Same standard as Phase 0: behaviour through public seams (HTTP, process lifecycle, database end state), never internal calls.
- **Seam 1 (Compose)** keeps every Phase 0 test, run against `harbor` with a minted tenant context. The tests' storefront client goes through the router with each shop's Host.
- **Cross-tenant isolation suite** (new), on every pull request:
  - API: with `meadow`'s context, `harbor`'s product, Cart, Order (even with a valid token), admin Order list, fulfillment, and Inventory effects are not found or not changed; Checkout of a `harbor` Cart under `meadow` is refused.
  - Context: missing, tampered, expired, and wrongly signed contexts are refused by both APIs and the storefront; a client-supplied context is replaced by the router.
  - Storefront: each shop's address shows only its own products and name; one shop's Merchant password and session do not work at the other; an Order link from one shop shows nothing at the other.
  - Database: as each runtime identity, a transaction with no tenant set reads no rows and cannot insert; a transaction set to one tenant cannot read, update, or insert rows of the other; composite foreign keys refuse a Cart line naming another tenant's product.
  - Schema: every table has a non-null `tenant_id` and RLS with policies.
- **Seam 2 (lab cluster):** `make smoke` checks both shops at `http://harbor.shop.localhost:8080` and `http://meadow.shop.localhost:8080`, and an unknown shop's `404`.

## Out of Scope

- The control plane, signup, and every lifecycle operation (Phase 2); the tenant table is static.
- More than one cell, waves, and tenant moves (Phases 3, 4, 6).
- Per-tenant rate limits, quotas, and queue fairness (Phase 5).
- A tenant label on metrics, per-tenant dashboards and alerts (Phase 5).
- Custom domains and per-tenant TLS.
- Per-cell credentials beyond the one cell (the admin service token and database identities stay as they are).

## Further Notes

- **Verify during implementation, not from memory:** how `@fastify/http-proxy` forwards `Host` and request bodies (form posts must reach the storefront unchanged); that `*.shop.localhost` resolves to loopback for the test runner on macOS and on Ubuntu CI runners, or else the tests' client sets `Host` itself; that Traefik accepts a wildcard host in a standard Ingress.
- **Steps only the author can perform:** merging ticket 01 before tickets 02–04, so the router image and digest exist.
