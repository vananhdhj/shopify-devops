# 04: Suspend, reinstate, and delete

**What to build:** The platform operator suspends, reinstates, and deletes shops through operator endpoints and `make tenant-*` targets. Deletion purges the shop's rows from the cell through narrow `purge_tenant` functions and verifies that none remain before the shop is `DELETED`.

**Blocked by:** 03

**Status:** resolved

- [x] Operator endpoints (list, events, suspend, reinstate, delete) refused without `PLATFORM_OPERATOR_TOKEN`; each action writes a `tenant_events` row with actor `operator`
- [x] `make tenant-list`, `make tenant-suspend`, `make tenant-reinstate`, `make tenant-delete` (by handle)
- [x] Cell: `catalog.purge_tenant` and `orders.purge_tenant` (`SECURITY DEFINER`, return remaining counts per table); `POST /internal/tenants/:tenantId/purge` on both APIs, refused without `PLATFORM_CELL_TOKEN`
- [x] `platform-worker` deletion: stop routing (`DELETING`), purge orders then catalog, verify zero rows in all eight tables, record the counts, mark `DELETED`; idempotent across crashes
- [x] Seam-1 tests: suspension shows the unavailable page and lets a Pending order settle; reinstate restores the shop; deleting a shop with Carts, Orders (one Pending), and Inventory effects leaves zero rows in all eight tables and the other shop untouched; a crash mid-deletion resumes; purge endpoints refuse without the token; runtime identities still cannot `DELETE` outside the functions

## Comments

Implementation notes (2026-10-11):
- Operator endpoints take the shop's handle (`/operator/tenants/:handle/...`); repeating an action already in effect answers 409, so the audit trail records each move once. `make tenant-*` wraps them (`scripts/tenant.sh`; `PLATFORM_URL` for the cluster).
- Deletion runs in two passes: each pass purges the shop's Orders first (so no settle job can load one afterwards), then its catalog. A settle job that had already loaded an Order can still write an Inventory effect for a few seconds, so after a grace (`DELETE_GRACE_MS`, 15 s; 3 s in Compose) a second pass runs, and the shop is `DELETED` only when a pass deletes nothing and finds nothing left. Each pass is recorded with its counts as a `purged` event; the final `deleted` event carries the verified zero counts.
- The purge functions are `SECURITY DEFINER` (owned by the migration identity), granted only to the runtime identity of their schema; the endpoints run outside any tenant context and require `PLATFORM_CELL_TOKEN`.

Resolved 2026-10-11. `make test`: 165 of 167 passed, all new lifecycle tests among them. The two failures came from CPU contention (load average about 40 on 6 CPUs with the k3d cluster running beside the Compose stack): a signup that hit the registry database's 2-second connection timeout (500) during the 20-concurrent-retries test, and a test Cart that was not created in time (Checkout answered 400) in the connection-cut test. Both files pass on a re-run. New tests: operator endpoints refuse without the token; the list shows status and cell; suspension serves the unavailable page, lets a Pending order settle, keeps the data, and reinstatement restores the shop, with each operator step audited once; deleting a shop that has rows in all eight tables leaves none, records the verification, leaves Harbor Goods untouched, and cannot be reinstated; a worker stopped after the first purge pass finishes the deletion on restart; purge endpoints refuse without the cell token even with a tenant context; runtime identities still cannot `DELETE` outside the functions.
