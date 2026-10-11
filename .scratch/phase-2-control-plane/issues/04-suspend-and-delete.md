# 04: Suspend, reinstate, and delete

**What to build:** The platform operator suspends, reinstates, and deletes shops through operator endpoints and `make tenant-*` targets. Deletion purges the shop's rows from the cell through narrow `purge_tenant` functions and verifies that none remain before the shop is `DELETED`.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] Operator endpoints (list, events, suspend, reinstate, delete) refused without `PLATFORM_OPERATOR_TOKEN`; each action writes a `tenant_events` row with actor `operator`
- [ ] `make tenant-list`, `make tenant-suspend`, `make tenant-reinstate`, `make tenant-delete` (by handle)
- [ ] Cell: `catalog.purge_tenant` and `orders.purge_tenant` (`SECURITY DEFINER`, return remaining counts per table); `POST /internal/tenants/:tenantId/purge` on both APIs, refused without `PLATFORM_CELL_TOKEN`
- [ ] `platform-worker` deletion: stop routing (`DELETING`), purge orders then catalog, verify zero rows in all eight tables, record the counts, mark `DELETED`; idempotent across crashes
- [ ] Seam-1 tests: suspension shows the unavailable page and lets a Pending order settle; reinstate restores the shop; deleting a shop with Carts, Orders (one Pending), and Inventory effects leaves zero rows in all eight tables and the other shop untouched; a crash mid-deletion resumes; purge endpoints refuse without the token; runtime identities still cannot `DELETE` outside the functions

## Comments
