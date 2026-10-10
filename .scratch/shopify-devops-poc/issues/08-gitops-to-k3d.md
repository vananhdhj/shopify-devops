# 08: GitOps — a merged commit deploys to k3d automatically

**What to build:** Merging to main ends with the new image running in a local k3d cluster with no manual application of manifests. `make cluster-up` creates the cluster on Colima; `make bootstrap-gitops` installs Argo CD and points it at this repository; CI commits each new digest into the dev overlay using a bot deploy key that is the only bypass on main, without retriggering the build (ADR-0003). This ticket also measures whether the stack fits in Colima's 10 GB, the POC's main feasibility risk.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] `make cluster-up` creates a single-server k3d cluster with Traefik; the storefront is reachable at `http://shop.localhost:8080`
- [ ] `make bootstrap-gitops` installs Argo CD with automated sync; Argo CD is reachable only by port-forward
- [ ] Kustomize base plus dev and staging overlays; only dev is applied; CI renders and validates both on pull requests
- [ ] Workloads reference images by digest and declare resource requests and limits, startup, readiness, and liveness probes, and scoped service accounts
- [ ] Migrations run once per release as an Argo CD PreSync job before new pods start
- [ ] `make secrets` creates the Kubernetes Secrets; Argo CD apps reference them by name and do not manage them
- [ ] After a merge to main, CI commits the new digest to the dev overlay with the deploy key; that commit does not start another build; Argo CD deploys it
- [ ] The deploy-key bypass and trigger behavior are verified against GitHub, not assumed
- [ ] `make smoke` checks that the storefront serves the seeded products
- [ ] Memory use of the Colima VM and of each component is measured and recorded with the stack running

## Comments

- Carried from ticket 01 review: schemas are created by the superuser role-bootstrap step (not dbmate) and migrations/seed are mounted from the host in Compose; the in-cluster migration job needs its own way to run role bootstrap and ship migration files.
- Carried from ticket 05: the cluster's Redis must run with persistence (`--appendonly yes`), `--maxmemory-policy noeviction`, a password, and a persistent volume, exactly as in Compose; and the worker's retry/reconciliation settings (SETTLE_ATTEMPTS, SETTLE_BACKOFF_MS, RECONCILE_INTERVAL_MS, RECONCILE_STALE_AFTER_MS) must be set per environment (production-like defaults, not the short dev values).
