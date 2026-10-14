# 07: Close Phase 7: traces, a blocked manifest, a rotation

**What to build:** The exit gate on the lab cluster, then ADRs, glossary, and evidence.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** ready-for-agent

- [ ] Exit gate:
  - one shop's Checkout followed across the edge, the cell, and the queue in a single trace, with its log lines;
  - a pull request with a bad manifest blocked by CI;
  - dedicated-1's tenant-context secret rotated with zero failed requests.
- [ ] `docs/evidence/<date>-phase-7-cluster.md`, with memory before and after the new layers
- [ ] ADRs: lean logs and traces; manifest policy in CI, not admission; secrets sealed in Git; a secret rotated as expand/contract; autoscaling only stateless units
- [ ] `CONTEXT.md` (only domain terms, if any arise), README (commands, results row, known limits: admission control, 24 h retention)
- [ ] Spec status resolved
