# 05: The control plane on the lab cluster, and the record of Phase 2

**What to build:** The control plane runs in its own `platform-dev` namespace as its own Argo CD Application, the cell's router reads it, and the repository explains it: glossary, ADRs, README, and measured evidence, including a control-plane outage drill.

**Blocked by:** 04

**Status:** resolved

- [x] Kubernetes: `platform-dev` namespace with PostgreSQL, migration Job, `platform-api` and `platform-worker` Deployments, Secrets wiring; Argo CD Application `platform-dev`; the router in `shop-dev` in registry mode; static mode removed
- [x] `make smoke` signs up a throwaway shop, buys from it, deletes it, and checks zero rows
- [x] Control-plane outage drill on the cluster: with `platform-api` scaled to 0, both seeded shops serve buyers; signup fails cleanly; recovery restores signup
- [x] `CONTEXT.md` gains Control plane, Registry, Signup, Suspended and Deleted shops; ADRs: the control plane's own database, tenants are data and cells are infrastructure, credential version in the tenant context, deletion through purge functions with verification
- [x] README and `docs/evidence/` record signup-to-ACTIVE time, deletion verification, the outage drill, and memory with the control plane running
- [x] Delivery checklist: `make secrets` against the cluster before the merge syncs

## Comments

Progress (2026-10-11):
- `deploy/platform/` (base, dev and staging overlays) and `deploy/argocd/platform-dev.yaml`: the registry's PostgreSQL, a PreSync migration Job (`migrate-platform.sh` in the db-migrations image: roles, dbmate, registry seed), `platform-api` (public and internal ports), `platform-worker`, a PodMonitor. The cell's router reads the registry (static file and `shop-tenants` removed); the Ingress also routes the bare base domain to the router; storefront and both APIs get the new tokens from `shop-env` and `shop-secrets`. kubeconform: cell dev 30, cell staging 29, control plane dev 12 and staging 12 resources valid; every image pinned.
- `cluster-secrets.sh` writes `platform-secrets` into the control plane's namespace with only its keys, drops the control plane's keys from the cell's `shop-secrets`, and warns loudly when the cluster is unreachable (the Phase 1 lesson). The release job's digest step updates every dev overlay that lists an image.
- `make smoke` (check mode) runs a throwaway shop's whole lifecycle (`scripts/smoke-lifecycle.sh`).
- `CONTEXT.md` gains Control plane, Registry, Signup, Provisioning, Active, Suspended, and Deleted shop; ADRs 0013–0016 and an amendment to ADR-0011; README updated.
- Left, after the merge and sync: apply the `platform-dev` Application (`make bootstrap-gitops` does it on a fresh cluster), `make smoke` on the cluster, the control-plane outage drill, and the evidence file with signup-to-ACTIVE time, deletion verification, the drill, and memory.

Resolved 2026-10-11. PRs #22 and #23 merged; `platform-dev` and `shop-dev` Synced and Healthy on the Phase 2 images. `make smoke` passes on the cluster (signup to ACTIVE 0.24 s; deletion verified with zero rows in 15.4 s); `make drill-control-plane-outage` passes (120/120 buyer pages through a 60 s outage; signups recover); memory recorded (control plane 108 MiB; 6.1 GB free). Evidence: `docs/evidence/2026-10-11-phase-2-cluster.md`. The rollout caused a ~30-minute shop outage: the cell dropped its static tenant table before the control plane existed, and the control plane's first sync hung on a PreSync hook that needed its own Application's resources; fixed by sync waves (PR #23) and by terminating the stuck operation. Follow-ups in the evidence: dependency-first rollouts, the cell's migration hook, a 503 for an unreachable control plane, and test runs with the cluster stopped.
