# 08: Close Phase 5: the noisy-neighbour experiment

**What to build:** The exit gate on the lab cluster. One shop at 10× its rate quota gets 429s, not 5xx, and the other shops in its cell stay within 20% of their baseline Checkout p95. The dashboards show it. Then ADRs, glossary, evidence.

**Blocked by:** 02, 03, 04, 06, 07

**Status:** ready-for-agent

- [ ] `make experiment-noisy-neighbour`: k6 in a container, a 5-minute baseline for three starter shops, then 5 minutes with a fourth at 10× its quota; per-shop results; VM load recorded and a stalled host flagged
- [ ] `docs/evidence/<date>-phase-5-cluster.md`
- [ ] ADRs: fair dispatch; limits per tenant in the edge's memory; the tenant label budget
- [ ] `CONTEXT.md`: Rate quota, Product quota, Noisy neighbour, Synthetic Checkout (and amend Plan)
- [ ] Spec status resolved
