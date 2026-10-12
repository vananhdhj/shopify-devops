# 03: Switch the ingress to the edge and take the router out of the cell

**What to build:** Once the edge is healthy beside the old path, the wildcard and bare-domain Ingress move to `edge-dev`, the router leaves the cell's base, the control plane checks new shops through the edge, and the per-cell mode leaves the router's code. Its own release, so a failure rolls back by reverting one commit.

**Blocked by:** 02 (deployed and healthy on the cluster)

**Status:** resolved

- [ ] Ingress for `*.shop.localhost` and `shop.localhost` in `deploy/edge`; removed from `deploy/base` with the router Deployment, Service, and PodMonitor
- [ ] The platform worker checks a provisioned shop through the edge (`EDGE_URL` replaces `CELL_ROUTER_URL`)
- [ ] Router per-cell mode (`STOREFRONT_URL`, `TENANT_CONTEXT_SECRET`) removed; dashboards and alerts follow the router to the edge namespace
- [ ] Cell no longer holds `PLATFORM_ROUTER_TOKEN`
- [ ] Cluster: `make smoke` passes through the ingress after the switch; the cell has no router pods; the outage window of the switch measured and recorded

## Comments

Implementation notes (2026-10-12):
- The Ingress for `*.shop.localhost` and `shop.localhost` is `edge` in `deploy/edge` (hosts patched per overlay); the cell's base loses the router's Deployment, Service, Ingress, and PodMonitor, and the cell overlays their router patches, replicas, and image.
- The platform worker checks a provisioned shop through `EDGE_URL`. For the minutes between the merge and the digest commit the previous platform image still runs and reads `CELL_ROUTER_URL`, so the dev overlay keeps that too, pointing at the edge; it goes once that image is gone. For the same reason `shop-secrets` keeps `PLATFORM_ROUTER_TOKEN` and `platform-secrets` pool-1's old tokens this release.
- The router's single-cell mode is gone: `CELL_CREDENTIALS_DIR` is required.
- `scripts/watch-availability.sh <handle> <seconds>` probes a shop through the ingress every 250 ms and reports each change of answer and the longest outage; used for the switch, and later for the cell-outage drill.
- Two Applications change in one commit (`edge-dev` gains the Ingress, `shop-dev` prunes its router last), and Argo CD orders nothing across Applications. Both Ingresses existing at once is harmless (each routes pool-1's shops correctly); neither existing would be a 404 from Traefik, so the window is measured.
- The local stack registers pool-1 with capacity 10,000 (the cluster keeps 100): its registry keeps every test run's shops, since the volume outlives `make dev-down`, and the first run of this ticket hit `no_capacity` with 102 live test shops in a pool of 100.

`make test` passes locally (32 files, 182 tests) in 320 s with the k3d cluster stopped.

Resolved 2026-10-12 with PR #29 (`60f56ef`, digests `fa046b2`), after #30 (03a) steadied the node. A probe through the ingress (harbor, every 250 ms) ran from 10:32 UTC across both commits:
- The switch itself, at the merge commit: `platform-dev` synced at 11:13:39, the edge's Ingress appeared at 11:14:13, and `shop-dev` pruned its router and its Ingress last at 11:15:04. The two Ingresses overlapped for about 50 s and there was never a moment with neither: the probe recorded no failed request across the switch. The cell has no router Deployment, Service, or Ingress left, and the edge logs every pool-1 request.
- The digest commit's image rollout (new router and platform images, and every cell unit) cost about 19 s of intermittent failures (11:20:35–11:20:54: 502, 000, 500) while single-replica units replaced their pods: a terminating pod still receives requests until Traefik drops its endpoint. Not caused by the switch; a zero-downtime rollout (preStop delay, a second replica of the edge) is follow-up work for Phase 4's release waves.
- `make smoke` passed: the throwaway shop ACTIVE 1 s after signup, checked through the edge, sold, deleted, 0 rows left.
- Left for ticket 05, which touches the same files: drop `CELL_ROUTER_URL` from the platform overlay, `PLATFORM_ROUTER_TOKEN` from the cell's `shop-secrets`, and pool-1's compatibility tokens from `platform-secrets`, now that no image reads them.
