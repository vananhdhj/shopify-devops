# 04: The promoter

**What to build:** A loop in the cluster that soaks each wave on a new release, checks the gate, and dispatches `promote` for the next wave, or halts and alerts. It reads Argo CD and Prometheus, checks out in each cell's synthetic shop through the edge, and keeps its state in the registry so a restart resumes a soak and never promotes twice.

**Blocked by:** 01, 02, 03

**Status:** resolved

- [ ] `platform.promotions` and `platform.promotion_events` (migration): digest set, wave, state `soaking|promoted|halted`, soak start, gate results, exposed cells and real-tenant count
- [ ] `apps/platform/src/promoter-server.ts` in the platform image; `deploy/platform/base/platform-promoter.yaml` (one replica, probes per ADR-0017, a ServiceAccount with a Role to read Applications in `argocd`)
- [ ] Gate (a pure function over observations, unit-tested): Synced and Healthy on the digests; 5xx ratio ≤ 5% and oldest-Pending ≤ 60 s in the cell's namespace; no firing alert for it; every synthetic decline Checkout terminal within 30 s; for the whole `SOAK_SECONDS` (default 300)
- [ ] On pass: dispatch `promote.yml` with a fine-grained token (`GITHUB_PROMOTE_TOKEN`: Actions write on this repository only), from `platform-secrets` via `make secrets`; on fail: state `halted`, exposed tenants counted, `promotion_state` metric, `PromotionHalted` alert
- [ ] `GET /operator/promotions`; `make fleet` shows the current promotion
- [ ] Seam-1 tests against an HTTP stub for Argo CD, Prometheus, and GitHub: a passing soak dispatches once, a restart mid-soak resumes, a failed check halts and counts tenants, a halted digest set is never retried
- [ ] Before merge: the token created by the author and `make secrets` run; cluster: with the release still reaching every cell, the promoter sees wave 1 and 2 already on the digests and records them as promoted (no dispatch)

## Comments

Implementation notes (2026-10-13), in two pull requests per the two-step rule: the cluster's promoter Deployment runs `dist/promoter-server.js`, which the running platform image lacks until this PR's digest commit, and a crash-looping unit at the merge commit is what stuck Argo CD's operations in Phase 3.

Part 1 (this PR): the code, the migration, Compose, the tests.
- `platform.promotions` and `platform.promotion_events`. A release is the set of the platform's image digests a wave's cells run (`release_key`, sorted), soaked once per wave: `soaking`, `promoting` (dispatched), `promoted`, `halted`, or `superseded` (the wave moved on before it did). On a halt the row keeps the exposed cells and the real tenants they held.
- `promotion-gate.ts`, pure and unit-tested (`tests/integration/src/promotion-gate.test.ts`, no stack):
  - which wave holds a release the next wave lacks (none while a wave's cells disagree, i.e. mid-rollout; never the last wave);
  - the gate. A check fails the release only on two ticks in a row: a single blip on this host is noise.
- `Promoter` (`promoter.ts`), each tick:
  - settles soaking or promoting releases the fleet has since moved past (promoted) or away from (superseded);
  - starts a soak for each new candidate;
  - judges a soaking one from Argo CD's state, the cell's metrics, and the synthetic Checkout finished since the last tick (a new one starts each tick).
  On pass it dispatches `promote.yml` once. On halt it counts the real tenants in every cell running the release, records the failure, and never retries. A promotion dispatched but not seen in the next wave after 10 minutes is dispatched again.
- `promoter-sources.ts`: the cell Applications through the Kubernetes API (the service account's token and CA in the cluster), Prometheus instant queries, the synthetic Checkout through the edge by Host, and the workflow dispatch (`GITHUB_PROMOTE_TOKEN`).
- `promoter-server.ts`: a 15 s tick, a 300 s soak, and metrics on its own listener: `promotion_halted{wave}` (1 while a wave's current release is halted, so the alert resolves when the wave moves on), `promotion_soaking{wave}`, `promotion_gate_checks_total`, `promoter_ticks_total`.
- `GET /operator/promotions`; `make fleet` lists the latest five promotions (state, failure, exposed tenants).
- `make secrets` copies `GITHUB_PROMOTE_TOKEN` into `platform-secrets` (never generated: the author's fine-grained token).
- Compose: `platform-promoter` in profile `promoter`, for the tests only, against a stub that the test process serves on the host (`host.docker.internal:18199`, mapped with `host-gateway` so Linux CI resolves it). Its synthetic Checkouts are real, in pool-1's synthetic shop through the edge.
- Seam-1 tests (`promoter.test.ts`):
  - a release soaks, dispatches exactly once with the gated digests and a gate summary, and becomes promoted when the next wave runs it;
  - a restart mid-soak resumes the same promotion (same soak start, gate ticks continue, one soak event, one dispatch);
  - a 50% error ratio halts the release with pool-1's real tenant count, `promotion_halted{wave="0"} 1`, and the failure in `GET /operator/promotions`; it stays halted when the cell recovers, is never dispatched, and the metric clears once wave 0 reverts.

Part 2 (next PR, after this PR's digest commit and `make secrets`): `platform-promoter` Deployment, a read-only ClusterRole on Argo CD Applications (the overlay's namespace would move a Role out of `argocd`), the PodMonitor entry, and the `PromotionHalted` rule.

`make test` with the k3d cluster stopped: 32 files passed. Three tests failed in the first run. Two were promoter test mistakes: the dispatch was compared as JSON text, but jsonb reorders keys; and the gate of a fresh soak has no tick count yet. The third was `settle.test.ts`, a payment delay measured at 2.98 s against 3, in a file this ticket does not touch. After the fixes, the promoter, gate, settle, and cells files pass together (27 tests).

Part 2 (this PR, after part 1's digest commit and `make secrets`):
- `deploy/platform/base/platform-promoter.yaml`: the Deployment (one replica, `Recreate`, so two promoters never overlap), its ServiceAccount with a token, a read-only ClusterRole (get/list `applications.argoproj.io`) bound to it, and the `PromotionHalted` rule (`max by (wave) (promotion_halted) == 1`, severity page, so it reaches both receivers).
- The platform PodMonitor scrapes the promoter's ops port too.
- The ClusterRole and its binding are cluster-wide names (`shop-platform-promoter`); the staging overlay renders the same names, and it is never applied to the lab cluster.
- `platform-secrets` already holds `GITHUB_PROMOTE_TOKEN`: `make secrets` ran on 2026-10-13 before this PR.

Server dry-run on the cluster: the ServiceAccount, ClusterRole, ClusterRoleBinding, Deployment, and PrometheusRule are accepted.

Resolved 2026-10-13 with PRs #40 (`1d28dd1`, digests `78c60d2`) and #41 (`cac3981`). On the cluster: the migration made `platform.promotions`; `platform-promoter` Ready with no restart at 21:03; its ticks succeed (listing Argo CD's Applications through its ClusterRole works), and with every wave on the same release it soaked nothing and dispatched nothing (no row in `platform.promotions`); Prometheus scrapes it (`up` 1) and has loaded `PromotionHalted` (health ok).
