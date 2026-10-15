# 07: Close Phase 7: traces, a blocked manifest, a rotation

**What to build:** The exit gate on the lab cluster, then ADRs, glossary, and evidence.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** resolved

- [x] Exit gate:
  - one shop's Checkout followed across the edge, the cell, and the queue in a single trace, with its log lines;
  - a pull request with a bad manifest blocked by CI;
  - dedicated-1's tenant-context secret rotated with zero failed requests.
- [x] `docs/evidence/<date>-phase-7-cluster.md`, with memory before and after the new layers
- [x] ADRs: lean logs and traces; manifest policy in CI, not admission; secrets sealed in Git; a secret rotated as expand/contract; autoscaling only stateless units
- [x] `CONTEXT.md` (only domain terms, if any arise), README (commands, results row, known limits: admission control, 24 h retention)
- [x] Spec status resolved

## Comments

Resolved 2026-10-15 ([Phase 7 evidence](../../../docs/evidence/2026-10-15-phase-7-cluster.md)):
- **One Order in one trace**: `make experiment-trace` (ticket 03), 22 spans in five units, from the edge across the outbox and the queue to the settlement, 66 ms; its log lines in Loki.
- **A bad manifest blocked**: PR #83 marked the worker's container `privileged: true`. CI's `manifests` job failed with `no-privileged: Deployment/worker container worker is privileged` for all four cells it renders (4 of 2,376 checks), `ci-ok` failed, and GitHub reported the pull request BLOCKED. Closed unmerged.
- **A secret rotation rehearsed**: dedicated-1's tenant-context secret, three pull requests (#77, #80, #81), no request refused (ticket 05); the sealing key's restore rehearsed too (ticket 04).
- ADRs 0031 (lean logs and traces), 0032 (manifest policies in CI, with listed exceptions), 0033 (Secrets sealed in Git), 0034 (a secret rotated as expand and contract), 0035 (autoscaling only stateless units).
- `CONTEXT.md`: no change. Phase 7 added operational layers, not domain terms.
- README: the commands, the security model, the known limits, and Phase 7's results row.
- Memory with every layer running: the k3d node 5,029 MiB (4,067 at Phase 6's end), monitoring 1,604 MiB (1,044); the VM keeps 2,501 MiB available.

