# 04: A second cell in Compose, and the containment tests

**What to build:** `make dev-up CELLS=2` starts a second complete cell (`dedicated-1`: its own PostgreSQL, Redis, APIs, worker, storefront) as a second Compose project on the shared network, registered with the control plane. The default `make dev-up` keeps one cell. A test group that needs two cells runs only when the second cell is up.

**Blocked by:** 02

**Status:** in review

- [ ] `compose.cell.yaml`, run as its own project with `.secrets/cells/dedicated-1.env`, reached by network aliases (`dedicated-1-storefront`, …); `make dev-up CELLS=2`, `make dev-down` stops both
- [ ] `make secrets` generates `dedicated-1`'s file and mounts
- [ ] Seam-1 tests (two cells): a `plus` signup lands in `dedicated-1` and serves through the edge; its rows exist only in `dedicated-1`'s database; a second `plus` signup is refused; stopping `dedicated-1`'s PostgreSQL leaves Harbor and Meadow serving while the plus shop answers 503; deleting the plus shop purges `dedicated-1` and leaves `pool-1` untouched
- [ ] `make test` runs the two-cell group when the second cell is up and skips it, saying so, otherwise

## Comments

Implementation notes (2026-10-12):
- The second cell lives in `compose.dedicated-1.yaml`, in the same Compose project as pool-1 and the control plane, every service in profile `cells-2`. Every service and hostname is prefixed `dedicated-1-`, so on the shared network no name of one cell answers for the other (a separate project with pool-1's service names would have made `storefront` resolve to both cells). The file is generated from pool-1's services in `compose.yaml`; the two are to be kept in step.
- Compose interpolates one set of variables for the whole project, so `make secrets` also writes every non-default cell's secrets with the cell as prefix (`DEDICATED_1_…`) to `.secrets/compose-cells.env`, from `.secrets/cells/dedicated-1.env`. The platform's and the edge's mounts gain dedicated-1's files. The cluster gets them too with the next `make secrets` (harmless until ticket 05 registers the cell there).
- `make dev-up CELLS=2` adds the profile; `make dev-down` always stops both cells. The Makefile, the tests' `compose()` helper, and CI's log step all pass both files and all three secrets files.
- dedicated-1 registers itself as a dedicated cell of capacity 1, with a one-shot like pool-1's.
- `containment.test.ts` runs only when `dedicated-1-storefront` is running and healthy, and says so when skipped. `cells.test.ts` sets every real dedicated cell aside (unregistered) while it runs and restores it afterwards, so its placement tests see only the cells they register.
- `cellQuery(cell, sql)` reads a given cell's database (pool-1 on 55432, dedicated-1 on 55434).
- `make dev-up CELLS=2` registers dedicated-1 with a `compose run` after `up`: `up --wait` counts a one-shot that nothing depends on as failed when it exits, and the edge must not depend on an optional cell.

`make test` with both cells (`make dev-up CELLS=2`, then the suite) passes every file (33 files, 186 tests) in 329 s with the k3d cluster stopped; without the second cell the containment file skips and says why. New tests (`containment.test.ts`): a plus shop lands in dedicated-1 and is served through the edge, its Merchant signs in through dedicated-1's storefront (that cell's own token), its rows are in dedicated-1's database and none in pool-1's, and a second plus signup is refused; with dedicated-1's PostgreSQL stopped its shop answers 5xx while Harbor and Meadow keep answering 200, and it recovers once the database is back; with dedicated-1's storefront stopped the edge answers its 503 for that shop only; deleting the plus shop leaves no row of it in dedicated-1 and Harbor's rows in pool-1 unchanged, and frees the cell.
