# 03: Switch the ingress to the edge and take the router out of the cell

**What to build:** Once the edge is healthy beside the old path, the wildcard and bare-domain Ingress move to `edge-dev`, the router leaves the cell's base, the control plane checks new shops through the edge, and the per-cell mode leaves the router's code. Its own release, so a failure rolls back by reverting one commit.

**Blocked by:** 02 (deployed and healthy on the cluster)

**Status:** ready-for-agent

- [ ] Ingress for `*.shop.localhost` and `shop.localhost` in `deploy/edge`; removed from `deploy/base` with the router Deployment, Service, and PodMonitor
- [ ] The platform worker checks a provisioned shop through the edge (`EDGE_URL` replaces `CELL_ROUTER_URL`)
- [ ] Router per-cell mode (`STOREFRONT_URL`, `TENANT_CONTEXT_SECRET`) removed; dashboards and alerts follow the router to the edge namespace
- [ ] Cell no longer holds `PLATFORM_ROUTER_TOKEN`
- [ ] Cluster: `make smoke` passes through the ingress after the switch; the cell has no router pods; the outage window of the switch measured and recorded
