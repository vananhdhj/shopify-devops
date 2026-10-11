# 04: A second cell in Compose, and the containment tests

**What to build:** `make dev-up CELLS=2` starts a second complete cell (`dedicated-1`: its own PostgreSQL, Redis, APIs, worker, storefront) as a second Compose project on the shared network, registered with the control plane. The default `make dev-up` keeps one cell. A test group that needs two cells runs only when the second cell is up.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `compose.cell.yaml`, run as its own project with `.secrets/cells/dedicated-1.env`, reached by network aliases (`dedicated-1-storefront`, …); `make dev-up CELLS=2`, `make dev-down` stops both
- [ ] `make secrets` generates `dedicated-1`'s file and mounts
- [ ] Seam-1 tests (two cells): a `plus` signup lands in `dedicated-1` and serves through the edge; its rows exist only in `dedicated-1`'s database; a second `plus` signup is refused; stopping `dedicated-1`'s PostgreSQL leaves Harbor and Meadow serving while the plus shop answers 503; deleting the plus shop purges `dedicated-1` and leaves `pool-1` untouched
- [ ] `make test` runs the two-cell group when the second cell is up and skips it, saying so, otherwise
