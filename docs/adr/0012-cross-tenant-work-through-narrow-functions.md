---
status: accepted
---

# Work that spans tenants goes through narrow database functions

Three jobs must look at every tenant in the cell: the worker's outbox dispatcher, its reconciliation of stale Pending orders, and the oldest-Pending gauge. Instead of giving the order identity a way around row-level security, each gets a `SECURITY DEFINER` function owned by the migration identity: claim a batch of undispatched outbox events (with `FOR UPDATE SKIP LOCKED`, the locks lasting until the caller's transaction ends), mark events dispatched, requeue stale Pending orders, and report the oldest Pending age. They return only ids, tenants, and timestamps, never Order contents, and only the order identity may execute them. The order identity lost its direct `SELECT` and `UPDATE` on the outbox. Each settle job then carries its Order's tenant and runs every query in that tenant's transaction.

## Considered Options

- **A worker identity with `BYPASSRLS`**: rejected; the worker would read and write every shop's Orders freely, the very thing the cell's isolation exists to prevent.
- **A policy that lets the order identity see all outbox rows**: rejected; the same exposure, limited to one table but still unbounded.
- **One dispatcher per tenant**: rejected; it multiplies with every shop, and the cell has one queue anyway.

## Consequences

- The cross-tenant surface is four functions, readable in one migration (`db/orders/migrations/20261011000104_tenant_scoped_orders.sql`), and a test checks that the order identity cannot read or update the outbox directly.
- `mark_events_dispatched` takes any event id; a misuse could only delay an Order until reconciliation re-enqueues it, never change it.
- The oldest-Pending gauge stays cell-wide. A per-tenant gauge waits for the tenant dimension in metrics (blueprint, Phase 5).
- Queue jobs enqueued before tenancy carried no tenant; they ran out of attempts and reconciliation re-enqueued their Orders with one.
