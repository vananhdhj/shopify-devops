# 02: Tenant-scoped cell — tenant key, RLS, and tenant context in every service

**What to build:** Every tenant-owned row carries `tenant_id`, PostgreSQL row-level security limits each runtime identity to its transaction's tenant, and the storefront, both APIs, and the worker carry the tenant context end to end, including through the queue. Cross-tenant background work (outbox dispatch, reconciliation, the oldest-Pending gauge) goes through narrow `SECURITY DEFINER` functions. Order tokens bind the tenant. The Phase 0 suite passes against `harbor`; the isolation suite proves `meadow` cannot reach `harbor`'s data through the APIs or the database.

**Blocked by:** 01 (merged to main)

**Status:** ready-for-agent

- [ ] Migrations add `tenant_id` (default: the transaction's tenant) to all eight tables, backfill existing rows to `harbor`, make keys and foreign keys tenant-scoped, and enable RLS with policies for each runtime identity
- [ ] Dispatcher, reconciliation, and the oldest-Pending gauge use `SECURITY DEFINER` functions; the order identity loses direct outbox `SELECT` and `UPDATE`
- [ ] Seed data for both tenants (Meadow Supply's own catalog, including one product with Stock 1)
- [ ] Both APIs refuse business requests without a valid tenant context (`401 tenant_context_required`) and run every business query through `withTenant`
- [ ] The order service forwards the context to the catalog; the outbox payload and queue job carry `tenantId`; the worker sets the tenant for its transactions and mints a context for Inventory-effect calls
- [ ] The Order token is an HMAC over tenant id and order id
- [ ] The storefront refuses requests without a valid context (`404`) and forwards it on every backend call
- [ ] `tenantId` appears on every log line of tenant work
- [ ] Phase 0 seam-1 tests pass against `harbor`
- [ ] Isolation suite, API: `meadow`'s context cannot read or change `harbor`'s products, Carts, Orders (even with a valid token), admin list, fulfillment, or Inventory effects, and cannot check out a `harbor` Cart; missing, tampered, expired, and wrongly signed contexts are refused
- [ ] Isolation suite, database: as each runtime identity, no tenant set reads nothing and cannot insert; one tenant cannot read, update, or insert another's rows; a composite foreign key refuses a cross-tenant Cart line
- [ ] Schema test: every table has a non-null `tenant_id` and RLS with policies

## Comments
