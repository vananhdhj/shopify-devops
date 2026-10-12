# 06: Fleet view

**What to build:** One command that answers "what runs where": every cell's role, capacity, shop counts, API readiness, Argo CD sync and health, and image digests.

**Blocked by:** 01 (API), 05 (cluster columns)

**Status:** resolved

- [ ] `GET /operator/cells`: directory, shop counts by status, live readiness of each cell's catalog and order APIs (short timeout, never fails as a whole)
- [ ] `make fleet`: that view plus, from the cluster, each cell Application's sync and health and its image digests (short form), and the edge's
- [ ] Seam-1 test: the view counts shops per cell and marks a stopped cell's APIs not ready

## Comments

Implementation notes (2026-10-12):
- `GET /operator/cells` (operator token, internal listener): every cell in the directory with its role, capacity, first registration, shops by status (all five, zero-filled), `placed` (every status but DELETED: what the capacity counts), and the readiness of its catalog and order APIs asked now: `ready`, `not_ready` (the API answered that it is not ready, e.g. its database is down), or `unreachable`. All cells' APIs are asked at once, each with a 2.5 s timeout (longer than the APIs' own 2 s database connect timeout, so a database that hangs reads as `not_ready`); a cell that hangs costs the view that timeout and never fails it. A cell taken out of the directory is listed, unregistered, and not asked.
- `make fleet` (`scripts/fleet.sh`) port-forwards the control plane's internal listener on the lab cluster and prints the cells, then each Argo CD Application of the cells, the edge, and the control plane (sync, health, revision), then the images: one row per image, one column per Application, so a cell running another digest stands out. `make fleet FLEET=compose` prints the local stack's cells only. Locally the view also lists every earlier test run's retired `test-…` cell (their shops keep them in the directory); the cluster has none.
- Tests: `cells.test.ts` checks the view is operator-only, counts a test cell's shops as one is placed and activated, reports its unreachable orders API without failing, matches pool-1's count, and lists a retired cell unregistered and unasked. `containment.test.ts` (two cells): with dedicated-1's PostgreSQL stopped the view marks dedicated-1's catalog and order APIs `not_ready` and pool-1's `ready`, and dedicated-1's ready again once its database is back.

`make test CELLS=2` with the k3d cluster stopped: 32 files passed and the new fleet test failed in the first run (its plus signup took an earlier test's dedicated cell, free again once that cell's shop was deleted); with the earlier test cells retired first, `cells.test.ts` and `containment.test.ts` pass (15 tests).

Resolved 2026-10-12 with PR #33 (`834c9e8`, digests `0a30065`): no secret or manifest change; `make fleet` on the cluster showed the three cells ready with their shop counts, the five Applications Synced and Healthy at `0a30065`, and one digest per unit across all three cells (output in `docs/evidence/2026-10-12-phase-3-cluster.md`).
