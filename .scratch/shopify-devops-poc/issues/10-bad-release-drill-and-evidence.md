# 10: Bad-release drill and evidence — break it, detect it, revert it, write it up

**What to build:** The operator merges a commit that flips a fault flag in the dev overlay so Checkout returns 500, sees the server-error alert fire, recovers with `git revert`, and sees the alert resolve. The run is recorded as evidence, and the README lets a reviewer reproduce the whole lab with no undocumented steps.

**Blocked by:** 05, 06, 09

**Status:** ready-for-agent

- [ ] A fault flag in environment configuration makes Checkout return 500 for every request when enabled
- [ ] `make smoke` drill mode generates enough traffic to meet the alert's minimum volume and asserts the alert fires at the in-cluster catcher
- [ ] Reverting the fault commit restores Checkout through Argo CD, and the alert resolves at both receivers
- [ ] Recorded evidence: fault commit, revert commit, image digests, Argo CD revisions, alert fire and resolve timestamps, smoke results
- [ ] README explains the problem, app scope, prerequisites (including the author-only steps), startup, the delivery path, the security model, known limits, measured results (including the memory measurement and any failed experiments), and teardown
- [ ] Evidence distinguishes what is automatic (deployment, retry, pod replacement) from what is operator-driven (fault injection, revert)
