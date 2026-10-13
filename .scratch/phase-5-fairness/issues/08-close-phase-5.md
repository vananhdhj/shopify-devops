# 08: Close Phase 5: the noisy-neighbour experiment

**What to build:** The exit gate on the lab cluster. One shop at 10× its rate quota gets 429s, not 5xx, and the other shops in its cell stay within 20% of their baseline Checkout p95. The dashboards show it. Then ADRs, glossary, evidence.

**Blocked by:** 02, 03, 04, 06, 07

**Status:** resolved

- [ ] `make experiment-noisy-neighbour`: k6 in a container, a 5-minute baseline for three starter shops, then 5 minutes with a fourth at 10× its quota; per-shop results; VM load recorded and a stalled host flagged
- [ ] `docs/evidence/<date>-phase-5-cluster.md`
- [ ] ADRs: fair dispatch; limits per tenant in the edge's memory; the tenant label budget
- [ ] `CONTEXT.md`: Rate quota, Product quota, Noisy neighbour, Synthetic Checkout (and amend Plan)
- [ ] Spec status resolved

## Comments

Resolved 2026-10-14. Evidence: `docs/evidence/2026-10-14-phase-5-cluster.md`.
- **`make experiment-noisy-neighbour`** (`scripts/experiment-noisy-neighbour.sh`, `tests/load/noisy-neighbour.js`).
  - Four starter shops in pool-1, created on the first run and reused after. k6, pinned by digest, runs in a container on the k3d network and reaches the ingress by Host header.
  - Five minutes of baseline for three quiet shops, then five more with a fourth at 100 requests a second.
  - The VM's load is sampled throughout, and a run over 12 is void.
- **The run (VM load peak 2.2):**
  - the noisy shop got 26,976 × 429, 2,248 × 2xx, 0 × 5xx;
  - every quiet shop's Checkout p95 went from 22–23 ms to 15–18 ms, about 300 Checkouts each per phase and no failed journey. **The bound is met.** The lower p95 under noise is read as the baseline's warm-up, not a speed-up.
- **A test mistake, caught by the first short trial.** The k6 helper passed POST requests their options in the body's place, so every quiet journey failed. It was found with one k6 iteration printing each step, and fixed.
- **ADRs:** 0025 (fair dispatch into one settlement queue), 0026 (per-tenant limits in each unit's memory, sized by a plan the edge signs), 0027 (the tenant label is an id joined to `tenant_info`). They are numbered after Phase 4's 0022–0024 (#47).
- **`CONTEXT.md`:** Rate quota, Product quota, Noisy neighbour, Synthetic Checkout; Plan amended with what it limits.
