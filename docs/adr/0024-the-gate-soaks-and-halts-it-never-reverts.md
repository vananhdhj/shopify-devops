---
status: accepted
---

# The gate soaks a settled wave, halts on repeated failures, and never reverts

A release is promoted from a wave only after a **soak** of at least 5 minutes. The soak starts when every cell of the wave is Synced and Healthy on the release; a cell mid-rollout runs a mix of two releases, which is no release at all.

Every tick (15 s), the **gate** checks each cell of the wave:
- it is Synced and Healthy on the release;
- its 5xx ratio over the last two minutes is at or under 5%;
- its oldest Pending Order is at or under 60 s;
- no alert fires for its namespace;
- its synthetic Checkout (ADR-0023) reached a final state.

A check halts the release only when it fails on **two ticks in a row**. The gate passes once the soak has lasted, every cell has passed at least three synthetic Checkouts, and no check is failing.

A halted release is recorded with the cells that ran it and the real tenants they hold, `PromotionHalted` pages the operator, and the release is never retried. **The promoter never reverts.** The operator reverts the release's merge commit, and the next release replaces it in wave 0. The alert resolves when the wave moves on.

## Considered Options

- **Halt on the first failed check**: rejected. On this lab's host a single probe or Checkout times out every few minutes with nothing wrong (Phase 3 and 4 evidence), so good releases would halt.
- **Revert automatically**: rejected for now. A gate that can be fooled by its host must not be able to revert good releases, and a revert is a commit an operator should own. The blueprint allows it later, if drills show the gate is reliable.
- **A fixed soak per wave without metrics**: rejected. Time alone proves nothing; the Phase 4 drill's bad release was healthy by every Kubernetes measure.

## Consequences

- The drill's bad release (Checkout failing only inside Kubernetes, invisible to CI) was halted 49 s into the canary's soak, on the synthetic Checkout, with 0 real tenants exposed. `PromotionHalted` fired 23 s later.
- A slow host stretches a soak, because each tick waits for its queries and Checkouts: the reverted release soaked 970 s in pool-1 for 21 ticks. That is the safe direction.
- The ratio and the synthetic Checkout catch a broken path; a slow but working release passes. Latency gates are Phase 5's (per-tenant SLOs).
- A release that never settles (a cell stuck Progressing) is never soaked, and so never promoted, without an alert. `make fleet` shows it; an alert on a release stuck in wave 0 is a follow-up.
