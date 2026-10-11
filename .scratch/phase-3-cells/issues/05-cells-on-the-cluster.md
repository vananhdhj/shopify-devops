# 05: Three cells on the cluster through an ApplicationSet

**What to build:** Cells become directories: `deploy/cells/dev/{pool-1,canary,dedicated-1}`. An ApplicationSet makes one Application per directory. Pool-1 keeps the `shop-dev` namespace and its data; its hand-made Application is replaced by the generated one without deleting anything. The canary cell holds the platform's synthetic shop.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] ApplicationSet controller enabled in `deploy/argocd/values.yaml`; `deploy/argocd/cells-dev.yaml` (Git directory generator, `PruneLast`, automated sync, retries)
- [ ] `deploy/cells/dev/<cell>/kustomization.yaml`: namespace, role and capacity for registration, per-cell seed; `deploy/overlays/dev` moves to `deploy/cells/dev/pool-1`
- [ ] Runbook and execution: orphaning delete of `shop-dev`, generated `cells-dev-pool-1` adopts its resources with no pod restarted
- [ ] `make secrets` writes each cell's `shop-secrets` into its namespace and every cell's credentials to `platform-dev` and `edge-dev`
- [ ] The synthetic shop `canary` (internal) in the platform seed, placed in the canary cell, with a seed catalog there only
- [ ] Release pins digests in every cell directory; CI validates every cell directory
- [ ] Cluster: all three cells Synced and Healthy and registered; a `plus` signup lands in `dedicated-1`; `make smoke` passes for a shop in each cell
