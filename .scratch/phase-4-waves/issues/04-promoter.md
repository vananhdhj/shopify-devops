# 04: The promoter

**What to build:** A loop in the cluster that soaks each wave on a new release, checks the gate, and dispatches `promote` for the next wave, or halts and alerts. It reads Argo CD and Prometheus, checks out in each cell's synthetic shop through the edge, and keeps its state in the registry so a restart resumes a soak and never promotes twice.

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

- [ ] `platform.promotions` and `platform.promotion_events` (migration): digest set, wave, state `soaking|promoted|halted`, soak start, gate results, exposed cells and real-tenant count
- [ ] `apps/platform/src/promoter-server.ts` in the platform image; `deploy/platform/base/platform-promoter.yaml` (one replica, probes per ADR-0017, a ServiceAccount with a Role to read Applications in `argocd`)
- [ ] Gate (a pure function over observations, unit-tested): Synced and Healthy on the digests; 5xx ratio ≤ 5% and oldest-Pending ≤ 60 s in the cell's namespace; no firing alert for it; every synthetic decline Checkout terminal within 30 s; for the whole `SOAK_SECONDS` (default 300)
- [ ] On pass: dispatch `promote.yml` with a fine-grained token (`GITHUB_PROMOTE_TOKEN`: Actions write on this repository only), from `platform-secrets` via `make secrets`; on fail: state `halted`, exposed tenants counted, `promotion_state` metric, `PromotionHalted` alert
- [ ] `GET /operator/promotions`; `make fleet` shows the current promotion
- [ ] Seam-1 tests against an HTTP stub for Argo CD, Prometheus, and GitHub: a passing soak dispatches once, a restart mid-soak resumes, a failed check halts and counts tenants, a halted digest set is never retried
- [ ] Before merge: the token created by the author and `make secrets` run; cluster: with the release still reaching every cell, the promoter sees wave 1 and 2 already on the digests and records them as promoted (no dispatch)
