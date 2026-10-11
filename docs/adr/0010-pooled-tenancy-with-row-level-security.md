---
status: accepted
---

# Tenants share a cell's database, and row-level security keeps them apart

Many shops (tenants) run in one cell, on one PostgreSQL database with the same two schemas. Every tenant-owned row carries a non-null `tenant_id`, and PostgreSQL row-level security limits each runtime identity to the tenant its service set for the current transaction (`app.tenant_id`, transaction-local). The database enforces the boundary, so a bug in shared code cannot read or write another shop's data, and a transaction that forgets to set a tenant sees no rows and cannot insert. The cell, not the tenant, is the unit of separate infrastructure: a tenant that needs its own database gets a dedicated cell (blueprint, Phase 3).

## Considered Options

- **A schema or database per tenant**: rejected; migrations and connections multiply with every shop, and the lab cannot afford many databases. Its isolation is available as a dedicated cell.
- **Filtering by `tenant_id` in application queries only**: rejected; one missed `WHERE` clause leaks a shop, and nothing would prove it never happens.
- **`FORCE ROW LEVEL SECURITY`**: not used. The migration identity owns the tables and needs to work across tenants for migrations, seeding, and the narrow cross-tenant functions (ADR-0012). The runtime identities never own a table and have no `BYPASSRLS`, which a test checks.

## Consequences

- New rows take their tenant from the column default (the transaction's tenant), so inserts never name one, and the catalog identity cannot set `tenant_id` on products at all (its column-level `INSERT` grant leaves it out).
- Keys and foreign keys are tenant-scoped (`(tenant_id, id)`, composite foreign keys): a Cart line can only name a product of the same shop, even when written by the table owner. Checkout keys and source Carts are unique per shop (ADR-0001 holds per tenant).
- Every business query runs inside `withTenant`, one transaction per unit of work. Checkout reads the Cart over HTTP between two such transactions, never inside one.
- A schema test fails CI when a table in `catalog` or `orders` lacks a non-null `tenant_id` or row-level security with policies.
- Rows from the single-shop era were backfilled to the first tenant, Harbor Goods. The rollout that introduced this broke the old pods for its duration; expand/contract migrations are Phase 4.
