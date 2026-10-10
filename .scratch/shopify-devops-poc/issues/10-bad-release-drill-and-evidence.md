# 10: Bad-release drill and evidence — break it, detect it, revert it, write it up

**What to build:** The operator merges a commit that flips a fault flag in the dev overlay so Checkout returns 500, sees the server-error alert fire, recovers with `git revert`, and sees the alert resolve. The run is recorded as evidence, and the README lets a reviewer reproduce the whole lab with no undocumented steps.

**Blocked by:** 05, 06, 09

**Status:** resolved

- [x] A fault flag in environment configuration makes Checkout return 500 for every request when enabled
- [x] `make smoke` drill mode generates enough traffic to meet the alert's minimum volume and asserts the alert fires at the in-cluster catcher
- [x] Reverting the fault commit restores Checkout through Argo CD, and the alert resolves at both receivers
- [x] Recorded evidence: fault commit, revert commit, image digests, Argo CD revisions, alert fire and resolve timestamps, smoke results
- [x] README explains the problem, app scope, prerequisites (including the author-only steps), startup, the delivery path, the security model, known limits, measured results (including the memory measurement and any failed experiments), and teardown
- [x] Evidence distinguishes what is automatic (deployment, retry, pod replacement) from what is operator-driven (fault injection, revert)

## Comments

Resolved 2026-10-10.
- Fault flag: `FAULT_CHECKOUT_ERRORS=true` makes order-service answer every Checkout with 500 while staying ready (PR #9, with an integration test that also checks the 5xx is recorded on the `/checkout` route). `make smoke MODE=fault` and `MODE=recover` drive the drill against the in-cluster alert catcher.
- Run 2 (accepted): fault 55fc76a (PR #13) → FIRING 1 min 34 s after the fault went live → `git revert` f96dc45 (PR #14) → Checkout working 2 min 14 s after FIRING → RESOLVED 2 min 12 s later, once at each receiver. Images unchanged (built from 477ecae); Argo CD revisions, timings, and the automatic vs operator-driven split in docs/evidence/2026-10-10-bad-release-drill.md.
- Run 1 (failed experiment): with one recovery Checkout every 5 s, the alert resolved because the request rate fell to its minimum, 36 s before the revert reached the pods, then fired again after recovery. Fixed in the drill (PR #12): traffic never pauses, and only a resolution after the first accepted Checkout counts. Follow-up: the alert rule gained `keep_firing_for: 1m` so a short traffic lull no longer ends it; the trade-off is listed in the README's known limits.
- README: problem, app scope, prerequisites with the author-only steps, startup, delivery path, security model, known limits, measured results with failed experiments, and teardown.
