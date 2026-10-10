# 08: GitOps — a merged commit deploys to k3d automatically

**What to build:** Merging to main ends with the new image running in a local k3d cluster with no manual application of manifests. `make cluster-up` creates the cluster on Colima; `make bootstrap-gitops` installs Argo CD and points it at this repository; CI commits each new digest into the dev overlay using a bot deploy key that is the only bypass on main, without retriggering the build (ADR-0003). This ticket also measures whether the stack fits in Colima's 10 GB, the POC's main feasibility risk.

**Blocked by:** 07

**Status:** resolved

- [x] `make cluster-up` creates a single-server k3d cluster with Traefik; the storefront is reachable at `http://shop.localhost:8080`
- [x] `make bootstrap-gitops` installs Argo CD with automated sync; Argo CD is reachable only by port-forward
- [x] Kustomize base plus dev and staging overlays; only dev is applied; CI renders and validates both on pull requests
- [x] Workloads reference images by digest and declare resource requests and limits, startup, readiness, and liveness probes, and scoped service accounts
- [x] Migrations run once per release as an Argo CD PreSync job before new pods start
- [x] `make secrets` creates the Kubernetes Secrets; Argo CD apps reference them by name and do not manage them
- [x] After a merge to main, CI commits the new digest to the dev overlay with the deploy key; that commit does not start another build; Argo CD deploys it
- [x] The deploy-key bypass and trigger behavior are verified against GitHub, not assumed
- [x] `make smoke` checks that the storefront serves the seeded products
- [x] Memory use of the Colima VM and of each component is measured and recorded with the stack running

## Comments

- Carried from ticket 01 review: schemas are created by the superuser role-bootstrap step (not dbmate) and migrations/seed are mounted from the host in Compose; the in-cluster migration job needs its own way to run role bootstrap and ship migration files.
- Carried from ticket 05: the cluster's Redis must run with persistence (`--appendonly yes`), `--maxmemory-policy noeviction`, a password, and a persistent volume, exactly as in Compose; and the worker's retry/reconciliation settings (SETTLE_ATTEMPTS, SETTLE_BACKOFF_MS, RECONCILE_INTERVAL_MS, RECONCILE_STALE_AFTER_MS) must be set per environment (production-like defaults, not the short dev values).

Resolved 2026-10-10.
- Lab: `make cluster-up` (k3d 5.9, k3s v1.35.5, Traefik on 127.0.0.1:8080), `make secrets` (also loads the cluster Secret, without the Merchant's plaintext password), `make bootstrap-gitops` (Argo CD chart 10.10.2 / v3.5.4, ClusterIP only), `make smoke` OK against http://shop.localhost:8080.
- GitOps loop verified: PR #5 merged → release built 5 images × 2 architectures → `deploy-dev` pushed commit 8267677 (github-actions[bot], only the dev overlay) through the ruleset's deploy-key bypass → no release run for that commit → Argo CD synced it (Synced/Healthy) in about 35 s, running the PreSync migration Job and PostSync seed Job; all running digests match the overlay.
- Self-heal: scaling the worker to 0 by hand was reverted by Argo CD within about 2 s.
- Memory: 1.66 GiB for cluster, shop, and Argo CD; 7.8 GB free in Colima (docs/evidence/2026-10-10-k3d-memory.md).
- Carried items done: role bootstrap and migrations ship in the db-migrations image (from ticket 01); cluster Redis has append-only persistence, noeviction, a password, and a volume, and the worker uses production-like retry defaults (from ticket 05).
- Adding the deploy-key bypass needed the repository owner: the agent's attempt was held by a safety check, and the first two UI attempts did not save; it was finally applied through the API.

