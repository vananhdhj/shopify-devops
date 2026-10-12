# 07: Close Phase 4 — bad release halted at wave 0

**What to build:** The exit gate on the lab cluster: a bad release halts at wave 0 with the exposed-tenant count recorded, and a Git revert restores the canary. Then ADRs, glossary, evidence.

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] Drill: a PR that makes Checkout fail in the order service image, merged; it reaches wave 0 only; the gate fails, `PromotionHalted` reaches both receivers, the promotion record names the digest, the canary cell, and 0 real tenants exposed; pool-1 and dedicated-1 never run it and their error ratio is unchanged; reverting the merge commit restores the canary and that release promotes through every wave; timings recorded
- [ ] `docs/evidence/<date>-phase-4-cluster.md` (normal promotion timings, rollout availability, the drill, memory with the promoter)
- [ ] ADRs: promotion by an in-cluster promoter through a dispatched workflow (decisions 1, 2, 5); synthetic shops outside capacity; the gate
- [ ] `CONTEXT.md`: Wave, Release, Promotion, Soak, Gate, Synthetic shop
- [ ] Spec status resolved
