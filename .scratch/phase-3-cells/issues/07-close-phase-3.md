# 07: Close Phase 3 — drill, memory, evidence

**What to build:** The exit gate on the lab cluster: tenants on different cells, one cell's failure contained, memory recorded. Then the decisions of this phase become ADRs and the new terms enter `CONTEXT.md`.

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] `make drill-cell-outage CELL=dedicated-1`: scales the cell's PostgreSQL to zero, shows its shop answering 503 and the other cells' shops serving, restores it, and shows recovery; timings recorded
- [ ] Memory per cell, edge, control plane, and node total with three cells, against the Phase 2 numbers
- [ ] `docs/evidence/<date>-phase-3-cluster.md`
- [ ] ADRs: the edge router at platform level; cell registration and per-cell credentials; placement by plan in the signup transaction
- [ ] `CONTEXT.md`: Cell, Cell directory, Placement, Plan, Edge router, Fleet view
- [ ] Spec status resolved
