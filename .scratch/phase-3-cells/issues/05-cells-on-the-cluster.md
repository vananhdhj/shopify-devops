# 05: Three cells on the cluster through an ApplicationSet

**What to build:** Cells become directories: `deploy/cells/dev/{pool-1,canary,dedicated-1}`. An ApplicationSet makes one Application per directory. Pool-1 keeps the `shop-dev` namespace and its data; its hand-made Application is replaced by the generated one without deleting anything. The canary cell holds the platform's synthetic shop.

**Blocked by:** 03, 04

**Status:** resolved

- [ ] ApplicationSet controller enabled in `deploy/argocd/values.yaml`; `deploy/argocd/cells-dev.yaml` (Git directory generator, `PruneLast`, automated sync, retries)
- [ ] `deploy/cells/dev/<cell>/kustomization.yaml`: namespace, role and capacity for registration, per-cell seed; `deploy/overlays/dev` moves to `deploy/cells/dev/pool-1`
- [ ] Runbook and execution: orphaning delete of `shop-dev`, generated `cells-dev-pool-1` adopts its resources with no pod restarted
- [ ] `make secrets` writes each cell's `shop-secrets` into its namespace and every cell's credentials to `platform-dev` and `edge-dev`
- [ ] The synthetic shop `canary` (internal) in the platform seed, placed in the canary cell, with a seed catalog there only
- [ ] Release pins digests in every cell directory; CI validates every cell directory
- [ ] Cluster: all three cells Synced and Healthy and registered; a `plus` signup lands in `dedicated-1`; `make smoke` passes for a shop in each cell

## Comments

Implementation notes (2026-10-12):
- One directory per cell: `deploy/cells/dev/{pool-1,canary,dedicated-1}` (pool-1 is the old `deploy/overlays/dev`, rendering identically apart from the seed job's new `SEED_FILE`), and `deploy/cells/staging/pool-1`. Each directory has a `cell.json` (cell id and namespace). Namespaces: `shop-dev` (pool-1, kept so its data never moved), `cell-canary-dev`, `cell-dedicated-1-dev`.
- `deploy/argocd/cells-dev.yaml` is an ApplicationSet with a Git **files** generator over `deploy/cells/dev/*/cell.json`, not the directory generator the spec named: the files carry each cell's namespace, which pool-1 needs to keep `shop-dev`. It makes `cell-<id>-dev` per cell with automated sync, prune last, self-heal, and retries. `preserveResourcesOnDeletion` keeps a cell's resources when its directory or the ApplicationSet is deleted, since emptying a cell is a deliberate move of its shops (Phase 6). The ApplicationSet controller is enabled in `deploy/argocd/values.yaml`.
- The dev seed job is a shared component (`deploy/cells/components/dev-seed`). pool-1 seeds Harbor Goods and Meadow Supply (`catalog.sql`); the canary seeds the synthetic shop's catalog (`canary.sql`, by a patch); dedicated-1 has no seed.
- The synthetic shop `canary` (internal, id `…0003`) is entered by the platform seed only where `SEED_CANARY_SHOP=true` (the dev cluster), unplaced, with a provision request; the lifecycle worker places it once the canary cell registers. The handle `canary` is now reserved at signup.
- Secrets: the cell list is the directories under `deploy/cells/dev`. `make secrets` writes each cell's `shop-secrets` from its own file into the namespace its `cell.json` names, and every cell's credentials to the control plane and the edge. Ticket 03's leftovers are gone: `CELL_ROUTER_URL`, the router token in the cell's Secret, pool-1's old tokens in `platform-secrets`.
- The release pins digests in every cell directory (pool-1 first, where a new unit's first digest goes), the control plane, and the edge. CI renders and validates every cell directory.

Rollout runbook (the existing `shop-dev` Application points at `deploy/overlays/dev`, which this ticket moves):
1. Before the merge: `make secrets` (new namespaces with their `shop-secrets`; every cell's credentials to `platform-dev` and `edge-dev`).
2. Before the merge: `helm upgrade` Argo CD with the new values (`make bootstrap-gitops` does it), so the ApplicationSet controller runs.
3. Merge; wait for the digest commit (the `db-migrations` image changes: seeds). Meanwhile `shop-dev` finds its path gone: Argo CD cannot render it, so it applies and prunes nothing.
4. Delete the `shop-dev` Application without its resources (it has no resources finalizer, so deleting the Application leaves them). pool-1 keeps running, unmanaged, until step 5.
5. Apply `deploy/argocd/cells-dev.yaml`. `cell-pool-1-dev` adopts pool-1's resources (only the tracking label changes, no pod restarts); `cell-canary-dev` and `cell-dedicated-1-dev` create their cells; each registers with the control plane; the canary shop is placed in the canary cell.

`make test` passes locally (32 files and the containment file skipped with one cell; 182 tests) in 226 s with the k3d cluster stopped. The two new seed files were run against the Compose databases inside transactions that were rolled back: the canary shop enters as internal, PROVISIONING, unplaced, with one provision request; its catalog's three products pass the seed check. Every rendered manifest (four cells, the control plane and the edge in both environments, the three Argo CD definitions) passes kubeconform locally: 141 resources valid.

Resolved 2026-10-12 with PR #32 (`f616567`, digests `a9048ad`), following the runbook: `make secrets` and the Argo CD upgrade before the merge; at the merge commit `platform-dev` synced (the new `platform-env`) and `shop-dev` kept 847a045, its path gone; after the digest commit `shop-dev` was deleted without its resources (14:02:45 UTC) and `cells-dev.yaml` applied (14:02:46).
- Adoption: `cell-pool-1-dev` took over pool-1 in place. `postgres-0` and `redis-0` kept their pods (124 minutes old, no restart) and the cell's data. Its Deployments rolled once, to the digest commit's images, which arrived with the adoption since `shop-dev` had not synced them.
- All three cells Synced and Healthy at 14:16, about 13.5 minutes after the apply; each registered itself (`pool-1` pooled 100, `canary` canary 5, `dedicated-1` dedicated 1). The canary shop was placed in the canary cell and is ACTIVE; its storefront shows its three seed products and a Checkout there was Confirmed.
- A `plus` signup (`plus-a2d37b`) landed in `dedicated-1` and went ACTIVE; its Merchant signed in through dedicated-1's storefront and added a product, and a Checkout of it was Confirmed. A second `plus` signup was refused: 409 `no_capacity`. `make smoke` passed (pool-1: both shops, a Checkout, a throwaway shop signed up, sold, deleted, 0 rows left).
- The two new cells starting at once (two Postgres initdbs, ten app pods, seven new images) with pool-1, the control plane, and the edge rolling to new digests saturated the node: a probe through the ingress (harbor, every 250 ms, 14:02:33–14:12:33) saw 90 of 422 requests fail, mostly timeouts, longest outage 48.5 s. Third-party pods on default probes restarted (coredns 3, the Prometheus operator 2, Argo CD's repo server and server, metrics-server, kube-state-metrics 1 each); ours, on ADR-0017's probes, did not. Adding cells to a live node one at a time, or after the image rollout, is the lesson for the cell-outage drill and Phase 4.
- Node with three cells (14:19 UTC): MemAvailable 5.47 GB of 10.16 GB, down from 6.18 GB before the two new cells (12:09). Per namespace: pool-1 201 Mi, canary 193 Mi, dedicated-1 190 Mi, platform-dev 91 Mi, edge-dev 40 Mi, argocd 459 Mi, monitoring 889 Mi, kube-system 81 Mi. CPU stayed high after the start (load 25–30 on 6 vCPUs, CPU pressure about 70%) with the host Mac itself out of memory (64 MB free, 8 GB compressed): the lab's limit now is the host, not the cluster's memory.
