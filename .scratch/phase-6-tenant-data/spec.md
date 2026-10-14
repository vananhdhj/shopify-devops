# Spec: Phase 6 — tenant data operations

**Status:** resolved (2026-10-14: tickets 01–05 resolved; PRs #59–#63 and the ticket 05 PR merged and deployed to the lab cluster; the move and restore experiments met their bounds)

Background: the blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`) puts Phase 6 after fair sharing: "Tenant data operations: per-tenant export and restore, tenant move between cells". The exit gate is "Tenant move and per-tenant restore experiments pass with evidence". The bounds come from its experiments table:
- **Move:** move one tenant from `pool-1` to `dedicated-1` with a write freeze under 30 s, matching row counts and checksums, zero lost or duplicated Orders, and in-flight Pending Orders settled.
- **Restore:** restore one tenant to a point before a destructive Merchant action, without touching other tenants.

Phases 1–5 are resolved; ADRs 0001–0027 are binding.

Lessons that shape this phase:
- Pooled tenancy keeps a shop's rows in shared tables (ADR-0010), and only narrow SECURITY DEFINER functions cross tenants (ADR-0012).
- Deletion already purges and verifies through such functions (ADR-0016). A move or restore must be resumable like every lifecycle workflow.
- The laptop's memory is the lab's limit (Phase 5 evidence; Colima at 8 GB).

## Problem Statement

A shop cannot leave the cell it was placed in:
- A starter shop that upgrades to plus would have to move to a dedicated cell, and nothing can move it.
- pool-1 can never be emptied, so its namespace (`shop-dev`) can never be retired (Phase 3, decision 2).

A Merchant who deletes their catalog by mistake cannot get it back without restoring the whole cell's database, and with it every other shop in the cell.

## Solution

**A tenant move**, run by the control plane as a resumable lifecycle workflow:
1. Freeze the shop's writes. It stays readable; cart and Checkout answer "this shop is updating, try again in a moment".
2. Wait for its Pending Orders to settle.
3. Export its rows from the old cell and import them into the new one.
4. Verify every table's row count and checksum.
5. Switch its routing to the new cell and unfreeze.
6. Purge and verify-empty its rows in the old cell.

A failure before the switch undoes the import and unfreezes the shop where it was. A move into a dedicated cell is how a shop's plan becomes plus.

**Per-tenant exports and restore:**
- The control plane exports every shop's rows on a schedule, keeping the last few exports per shop.
- A restore freezes the shop the same way, replaces its rows in its cell with a chosen export, verifies, and unfreezes.
- Other shops in the cell are never touched: every step is scoped to one tenant id.

## Decisions (approved 2026-10-14)

1. **Moves copy, freeze, and verify.** The control plane exports through narrow per-cell functions and imports into the target cell. It compares counts and checksums per table, switches routing, and purges the source. This is simple, auditable, and takes seconds for lab-sized shops.
   - Alternative: logical replication with a publication filtered by `tenant_id`. Rejected for now: it needs replication privileges and network paths between cells' databases, and has far more moving parts, for a shorter freeze the lab's shops do not need.
2. **During a freeze the shop is read-only, not down.** The edge signs a read-only flag into the tenant context (as it signs the plan, ADR-0026).
   - The cell's APIs refuse the shop's writes with `503 shop_updating`, and the storefront shows "This shop is updating, try again in a moment". Browsing keeps working from the old cell.
   - Alternative: the edge pauses the whole shop. Rejected: buyers would lose browsing for the length of the move.
3. **Restore points are scheduled per-tenant exports, for now.** A job exports every shop's rows (the move's export functions) every `EXPORT_INTERVAL` (15 minutes) to a volume in the control plane's namespace, keeping the last 8 per shop. A restore re-imports a chosen export.
   - The restore point is only as fine as the interval. Changes since the last export are lost by a restore, and that is stated in the operator's command.
   - Alternative, **deferred, not rejected**: point-in-time recovery of the cell's PostgreSQL (a base backup and WAL archiving, replayed into an isolated scratch database, from which one shop is exported and re-imported). It restores to any moment, but every cell would gain archiving, disk, and memory the 16 GB laptop cannot spare. It is recorded in the README as the change to make when the lab has room (Phase 8's cloud run).

## User Stories

1. As the platform operator, `make tenant-move HANDLE=… CELL=…` moves a shop to another cell; its buyers can browse throughout, and at most 30 s pass with cart and Checkout refused.
2. As the platform operator, a move that fails part-way leaves the shop working in its old cell, with nothing of it in the new one.
3. As the platform operator, after a move the old cell holds no row of the shop, and the move's record shows each table's counts and checksums in both cells.
4. As a Merchant upgrading to plus, my shop moves to a dedicated cell of its own with all its products and Orders.
5. As a Merchant who deleted products by mistake, the platform operator can restore my shop to its last export from before the mistake, without touching any other shop.
6. As the platform operator, `make tenant-exports HANDLE=…` lists a shop's exports with their times and row counts.

## Implementation Decisions

- **Registry statuses:** `MOVING` and `RESTORING`, reached from `ACTIVE` and returning to it (the transition trigger allows `ACTIVE → MOVING → ACTIVE` and `ACTIVE → RESTORING → ACTIVE`). The edge serves both read-only.
- **Read-only context:** the tenant context gains `ro` (absent: false). Cell units on the previous release ignore it and keep accepting writes. A freeze is therefore only safe once every cell runs a release that honours it, which the waves ensure before the move workflow ships (ticket order).
- **Per-cell functions** (expand-only migrations, ADR-0021), in each schema:
  - `export_tenant(tenant)` returns its rows as JSON, table by table;
  - `import_tenant(tenant, rows)` inserts them, keeping ids;
  - `tenant_checksums(tenant)` returns each table's row count and an md5 over its rows in key order.
  Internal endpoints call them with the cell's own token (like purges).
- **Move workflow** (`platform-worker`, outbox action `move`, every step an event):
  1. freeze;
  2. drain Pending, up to 60 s;
  3. export;
  4. import;
  5. verify;
  6. switch the registry's cell, the plan for a dedicated target, and `ACTIVE`, in one transaction;
  7. purge and verify the source.
  Resuming after a crash repeats from the last step recorded. Undo before the switch: purge the target, unfreeze.
- **Exports:** a loop in `platform-worker` writes `/exports/<tenant>/<timestamp>.json` (rows plus checksums) to a PersistentVolumeClaim `tenant-exports` in `platform-dev`, every 15 minutes for every ACTIVE shop, keeping 8. Exports hold customer data: the volume is mounted only by the platform worker. Operator endpoints: `GET /operator/tenants/:handle/exports`, `POST /operator/tenants/:handle/restore {export}`.
- **Restore workflow:** freeze (`RESTORING`), drain Pending, purge the shop in its cell, import the export, verify against the export's checksums, unfreeze.
- **Experiments** (`make experiment-tenant-move`, `make experiment-tenant-restore`), recorded in the evidence:
  - **Move:** a starter shop with products, Carts, and Orders (some Pending) moves from pool-1 to dedicated-1, which is first freed of its test shop. Measured: the freeze, counts and checksums, Orders before and after, and the Pending Orders settled in the new cell; a probe through the ingress sees browsing answered throughout.
  - **Restore:** a shop's Merchant deletes products; the operator restores the export from before; the products are back. Another shop's rows are unchanged.

## Testing Decisions

- Seam 1 (Compose, two cells `CELLS=2`):
  - a move pool-1 → dedicated-1 with Pending Orders;
  - a failed move (the target's import endpoint unreachable) leaving the shop ACTIVE in pool-1 and nothing in dedicated-1;
  - a crash mid-move resuming;
  - read-only refusals during the freeze;
  - a restore after deleted products;
  - another shop's rows unchanged by all of it.
- Pure: the checksum is stable under row order; the transitions.
- Seam 2 (lab cluster): the two experiments.

## Out of Scope

- Point-in-time recovery (decision 3, deferred).
- Moving shops between environments.
- Plan downgrades out of a dedicated cell, and Merchant self-service plan changes.
- Export encryption and off-host copies (Phase 7's Sealed Secrets and Phase 8's cloud run).
