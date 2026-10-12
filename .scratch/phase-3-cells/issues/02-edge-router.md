# 02: Edge router — one router for every cell, beside the old path

**What to build:** The router learns the cell directory: it proxies each shop to its own cell's storefront and signs its tenant context with that cell's secret. In Compose the edge replaces the cell's router. On the cluster it runs as a new Application (`edge-dev`) beside the per-cell router, carrying no ingress traffic yet, so the switch (ticket 03) is a separate release.

**Blocked by:** 01

**Status:** resolved

- [ ] Router edge mode, chosen by `CELL_CREDENTIALS_DIR`: storefront URL from the routing table's cell, secret from `<cell>.tenant-context-secret`; without it, the per-cell mode stays unchanged (removed in ticket 03)
- [ ] A shop whose cell is unregistered, unknown to the edge, or lacking a secret answers 503 "temporarily unavailable", never another cell's page; metric of requests per cell
- [ ] The saved routing table includes the cell directory, so a restarted edge serves on it while the control plane is down
- [ ] Compose runs the edge on port 8000 in place of the cell's router
- [ ] `deploy/edge/{base,overlays/dev}` and `deploy/argocd/edge-dev.yaml` (`PruneLast`, waves); `edge-dev` Secrets from `make secrets`; CI validates the overlay; release pins its router digest
- [ ] Seam-1 tests: the existing router tests pass against the edge; a shop pointed at an unregistered cell answers 503; a context signed with another cell's secret is refused by the storefront
- [ ] Cluster: `edge-dev` Synced and Healthy; both shops answer through a port-forward to the edge with their Host headers; the ingress still reaches the cell's router

## Comments

Implementation notes (2026-10-12):
- The router picks its upstream per request (`apps/router/src/upstreams.ts`). Edge mode (`CELL_CREDENTIALS_DIR` set) takes the shop's cell from the routing table, that cell's storefront from the table's cell directory, and its secret from `<cell>.tenant-context-secret`. Single-cell mode (`STOREFRONT_URL`, `TENANT_CONTEXT_SECRET`) is unchanged, so the per-cell router in `shop-dev` runs the new image with its old manifest; it leaves in ticket 03.
- An active shop that is unplaced, in a cell the table does not list as registered, or in a cell whose secret the edge lacks answers 503 "temporarily unavailable", counted in `router_unroutable_requests_total{reason}`. Proxied requests are counted per cell in `router_proxied_requests_total{cell}`, and the "request completed" log line names the cell.
- The saved routing table carries the cell directory, so a restarted edge serves on it while the control plane is down (the existing restart test now runs against the edge).
- Compose: the `router` service is now `edge` (same port 8000), mounting `.secrets/mounts/edge`. `make dev-up` passes `--remove-orphans`, so an old `router` container cannot keep the port.
- Cluster: `deploy/edge/{base,overlays/dev,overlays/staging}` (Deployment, Service, PodMonitor; no Ingress until ticket 03) and `deploy/argocd/edge-dev.yaml`. `make secrets` writes `edge-secrets` (the router token) and `cell-credentials` (tenant-context secrets) into `edge-dev`. The release pins the router digest in the edge overlay too; CI renders and validates both edge overlays and the Application.
- No two-step merge needed although the edge needs the new router image: the edge overlay starts at the current router digest, but nothing deploys it until `edge-dev.yaml` is applied, after the release has pinned the new digest.

`make test` locally: the first run had one failure, `admin-orders` timing out while `docker compose stop worker` blocked for 196 s (a Docker stall: the file passes alone in 7 s, and the cell's worker is untouched by this ticket); the rerun passed every file (32 files, 182 tests) in 256 s with the k3d cluster stopped. New tests (`edge.test.ts`): a shop in a second registered cell is proxied there with that cell's secret and counted under its cell; an unregistered cell and a missing secret answer 503 with their reasons counted; a context signed with a secret the storefront does not hold gets the storefront's 404. The existing router tests, including the restart on a saved table while the control plane is down, now run against the edge.

Resolved 2026-10-12 with PR #28 (`e2472ff`, digests `6cb907e`). Both existing Applications synced the merge commit and then the digest commit without trouble (nothing they run changed its manifests). `edge-dev.yaml` was applied after the digest commit: the edge came up Synced and Healthy on the new router image (`sha256:d6fedd55…`). Through a port-forward to `svc/edge` with Host headers: Harbor Goods and Meadow Supply 200 with their own pages, an unknown shop the fixed 404, the bare domain the signup page; `router_proxied_requests_total{cell="pool-1"}` counted the shop requests and the log lines named the cell. Buyers still went through the cell's router.
