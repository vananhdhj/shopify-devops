# 02: Tenant-scoped cell — tenant key, RLS, and tenant context in every service

**What to build:** Every tenant-owned row carries `tenant_id`, PostgreSQL row-level security limits each runtime identity to its transaction's tenant, and the storefront, both APIs, and the worker carry the tenant context end to end, including through the queue. Cross-tenant background work (outbox dispatch, reconciliation, the oldest-Pending gauge) goes through narrow `SECURITY DEFINER` functions. Order tokens bind the tenant. The Phase 0 suite passes against `harbor`; the isolation suite proves `meadow` cannot reach `harbor`'s data through the APIs or the database.

**Blocked by:** 01 (merged to main)

**Status:** resolved

- [x] Migrations add `tenant_id` (default: the transaction's tenant) to all eight tables, backfill existing rows to `harbor`, make keys and foreign keys tenant-scoped, and enable RLS with policies for each runtime identity
- [x] Dispatcher, reconciliation, and the oldest-Pending gauge use `SECURITY DEFINER` functions; the order identity loses direct outbox `SELECT` and `UPDATE`
- [x] Seed data for both tenants (Meadow Supply's own catalog, including one product with Stock 1)
- [x] Both APIs refuse business requests without a valid tenant context (`401 tenant_context_required`) and run every business query through `withTenant`
- [x] The order service forwards the context to the catalog; the outbox payload and queue job carry `tenantId`; the worker sets the tenant for its transactions and names it in the body of Inventory-effect calls, which only its internal token may make
- [x] The Order token is an HMAC over tenant id and order id
- [x] The storefront refuses requests without a valid context (`404`) and forwards it on every backend call
- [x] `tenantId` appears on every log line of tenant work
- [x] Phase 0 seam-1 tests pass against `harbor`
- [x] Isolation suite, API: `meadow`'s context cannot read or change `harbor`'s products, Carts, Orders (even with a valid token), admin list, fulfillment, or Inventory effects, and cannot check out a `harbor` Cart; missing, tampered, expired, and wrongly signed contexts are refused
- [x] Isolation suite, database: as each runtime identity, no tenant set reads nothing and cannot insert; one tenant cannot read, update, or insert another's rows; a composite foreign key refuses a cross-tenant Cart line
- [x] Schema test: every table has a non-null `tenant_id` and RLS with policies

## Comments

Implementation notes (2026-10-11):
- `@shop/service-kit` adds the tenant layer: with `tenantContextSecret`, `createService` refuses every route without a valid context (401 `tenant_context_required`) unless the route is marked `withoutTenant` (probes, scrapes, the worker-only internal route), so a new route cannot forget the check. `tenantOf(req)` returns the verified tenant; `withTenant(db, tenantId, work)` runs one transaction with `app.tenant_id` set locally, so a pooled connection never carries a tenant into another request. Domain functions now take a client instead of the pool.
- New rows get their tenant from the column default (the transaction's tenant), so inserts did not change. With no tenant set, the policy check refuses an insert (`42501`) before the NOT NULL constraint would.
- The catalog identity cannot name a tenant on products at all: its `INSERT` grant there is column-level and excludes `tenant_id`.
- Checkout reads the Cart over HTTP between two tenant transactions, never inside one.
- The internal Inventory-effect endpoint takes `tenantId` in its body under the internal token (spec updated); the worker needs no tenant-context secret.
- Queue jobs enqueued before this change carry no tenant; they fail their attempts and reconciliation re-enqueues the Order with its tenant. The dev lab accepts that one-time cost.
- The test client calls the APIs as `harbor` by default (`api(url, init, tenant)`); the test browser goes through the router at `harbor.shop.localhost`.

Resolved 2026-10-11. `make test` passes from a wiped stack (25 files, 133 tests), and the migrations also ran against the existing Phase 0 data (backfilled to `harbor`). New tests: each shop sees only its own products; another shop's product, Cart (read, change, Checkout), Order (even with its valid token), admin list, and fulfillment are not found and not changed; a Merchant's new product lands only in their shop; an Inventory effect touches only the named tenant's Stock; missing, malformed, tampered, wrongly signed, expired, and future contexts are refused by both APIs; the storefront serves nothing without the router; probes and scrapes need no tenant; API log lines carry `tenantId`. Database: with no tenant set, each runtime identity reads no rows and cannot insert; one tenant reads and changes none of another's rows and cannot write rows naming it; the composite foreign key refuses a cross-tenant Cart line even for the table owner; every table has a non-null `tenant_id` and RLS with policies; neither runtime identity owns a table or bypasses RLS; the order identity cannot read or update the outbox directly.
