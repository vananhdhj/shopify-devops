# 07: Close Phase 3 — drill, memory, evidence

**What to build:** The exit gate on the lab cluster: tenants on different cells, one cell's failure contained, memory recorded. Then the decisions of this phase become ADRs and the new terms enter `CONTEXT.md`.

**Blocked by:** 05, 06

**Status:** in review

- [ ] `make drill-cell-outage CELL=dedicated-1`: scales the cell's PostgreSQL to zero, shows its shop answering 503 and the other cells' shops serving, restores it, and shows recovery; timings recorded
- [ ] Memory per cell, edge, control plane, and node total with three cells, against the Phase 2 numbers
- [ ] `docs/evidence/<date>-phase-3-cluster.md`
- [ ] ADRs: the edge router at platform level; cell registration and per-cell credentials; placement by plan in the signup transaction
- [ ] `CONTEXT.md`: Cell, Cell directory, Placement, Plan, Edge router, Fleet view
- [ ] Spec status resolved

## Comments

Implementation notes (2026-10-12):
- `make drill-cell-outage CELL=<cell>` (`scripts/drill-cell-outage.sh`): picks an active shop in the cell and one in every other registered cell (from the registry), pauses the cell's automated sync, scales its PostgreSQL to 0, requests every shop once a second for 60 s, then restores the database and the sync (also on any exit) and times the shop's recovery. It fails if the cell's shop kept answering 200, if any other cell's request failed, or if the pause did not hold. `deploy/argocd/cells-dev.yaml` gains `ignoreApplicationDifferences` for `/spec/syncPolicy/automated`, so the ApplicationSet does not undo the pause; the drill applies it first.
- Run on the cluster at 15:58 UTC with the VM quiet: dedicated-1's shop failed 1 s after its database stopped and recovered 5 s after the restore; the canary and Harbor Goods served 120 of 120 pages. The failed shop answered 500, not the 503 the ticket named: the storefront is up and its page fails on the not-ready catalog API, and a Next.js page cannot choose its status. The edge's 503 covers an unreachable storefront (the local containment tests). Recorded as a follow-up in the evidence.
- Memory with three cells, against Phase 2: `docs/evidence/2026-10-12-phase-3-cluster.md` (a cell about 170 MiB, the edge 34 MiB, the control plane 88 MiB; 5.4 GB still available in the VM).
- ADRs 0018 (one edge router for every cell), 0019 (cells register themselves with credentials of their own), 0020 (placement by plan in the signup transaction); ADR-0011 amended. `CONTEXT.md`: Cell (with its roles), Cell directory, Plan, Placement, Edge router, Fleet view.
- `make fleet` was run on the cluster once ticket 06's image landed; its output opens the evidence.
