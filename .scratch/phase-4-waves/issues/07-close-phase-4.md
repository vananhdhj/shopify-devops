# 07: Close Phase 4 — bad release halted at wave 0

**What to build:** The exit gate on the lab cluster: a bad release halts at wave 0 with the exposed-tenant count recorded, and a Git revert restores the canary. Then ADRs, glossary, evidence.

**Blocked by:** 05, 06

**Status:** resolved

- [ ] Drill: a PR that makes Checkout fail in the order service image, merged; it reaches wave 0 only; the gate fails, `PromotionHalted` reaches both receivers, the promotion record names the digest, the canary cell, and 0 real tenants exposed; pool-1 and dedicated-1 never run it and their error ratio is unchanged; reverting the merge commit restores the canary and that release promotes through every wave; timings recorded
- [ ] `docs/evidence/<date>-phase-4-cluster.md` (normal promotion timings, rollout availability, the drill, memory with the promoter)
- [ ] ADRs: promotion by an in-cluster promoter through a dispatched workflow (decisions 1, 2, 5); synthetic shops outside capacity; the gate
- [ ] `CONTEXT.md`: Wave, Release, Promotion, Soak, Gate, Synthetic shop
- [ ] Spec status resolved

## Comments

Resolved 2026-10-13. Evidence: `docs/evidence/2026-10-13-phase-4-cluster.md`.
- **Drill.** #45 made every Checkout fail inside Kubernetes only: CI's Compose stack never sets `KUBERNETES_SERVICE_HOST`, so the release passed every check, including `compat`. Merged at 00:20:06, it reached the canary only. It was halted at 00:25:09, 49 s into the soak, on the synthetic Checkout; exposed cells `canary`, 0 real tenants. `PromotionHalted` fired at 00:25:32 and the in-cluster catcher received it at 00:25:46. pool-1 and dedicated-1 never ran the digest, and no probed shop saw a 5xx.
- **Revert.** #46, merged at 00:54:27. The alert resolved at 00:57:02, and the release was in every cell at 01:25:44.
- The alert catcher's `caught` helper filters by namespace (default `shop-dev`). `PromotionHalted` aggregates by wave and carries none, so it was read from the catcher's log directly.
- **Memory** with the promoter: the VM still has 5,389 MiB available (Phase 3: 5,404).
- **ADRs.** 0022 (an in-cluster promoter dispatches promotions; decisions 1, 2, 5), 0023 (synthetic shops outside capacity), 0024 (the gate soaks settled waves, halts on repeated failures, never reverts).
- **`CONTEXT.md`.** Release, Wave, Soak, Gate, Promotion, Synthetic shop; the fleet view's definition now includes waves and promotions.
