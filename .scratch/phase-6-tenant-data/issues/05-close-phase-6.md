# 05: Close Phase 6 — move and restore experiments

**What to build:** The exit gate on the lab cluster, then ADRs, glossary, and evidence.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] `make experiment-tenant-move`: dedicated-1 freed of its test shop; a starter shop with products, Carts, and Pending Orders moves pool-1 → dedicated-1; freeze under 30 s; counts and checksums equal; Orders before = after; Pending settle; a probe through the ingress sees browsing answered throughout
- [ ] `make experiment-tenant-restore`: products deleted, restored from the export before; another shop's rows unchanged
- [ ] `docs/evidence/<date>-phase-6-cluster.md`
- [ ] ADRs: moves copy, freeze, and verify; a read-only freeze through the signed context; restore points are exports (PITR deferred)
- [ ] `CONTEXT.md`: Tenant move, Write freeze, Tenant export, Restore point
- [ ] Spec status resolved
