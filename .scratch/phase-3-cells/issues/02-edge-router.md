# 02: Edge router — one router for every cell, beside the old path

**What to build:** The router learns the cell directory: it proxies each shop to its own cell's storefront and signs its tenant context with that cell's secret. In Compose the edge replaces the cell's router. On the cluster it runs as a new Application (`edge-dev`) beside the per-cell router, carrying no ingress traffic yet, so the switch (ticket 03) is a separate release.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Router edge mode, chosen by `CELL_CREDENTIALS_DIR`: storefront URL from the routing table's cell, secret from `<cell>.tenant-context-secret`; without it, the per-cell mode stays unchanged (removed in ticket 03)
- [ ] A shop whose cell is unregistered, unknown to the edge, or lacking a secret answers 503 "temporarily unavailable", never another cell's page; metric of requests per cell
- [ ] The saved routing table includes the cell directory, so a restarted edge serves on it while the control plane is down
- [ ] Compose runs the edge on port 8000 in place of the cell's router
- [ ] `deploy/edge/{base,overlays/dev}` and `deploy/argocd/edge-dev.yaml` (`PruneLast`, waves); `edge-dev` Secrets from `make secrets`; CI validates the overlay; release pins its router digest
- [ ] Seam-1 tests: the existing router tests pass against the edge; a shop pointed at an unregistered cell answers 503; a context signed with another cell's secret is refused by the storefront
- [ ] Cluster: `edge-dev` Synced and Healthy; both shops answer through a port-forward to the edge with their Host headers; the ingress still reaches the cell's router
