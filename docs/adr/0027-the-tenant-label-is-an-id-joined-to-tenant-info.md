---
status: accepted
---

# Tenant-labelled metrics carry the tenant's id, joined to `tenant_info` for names and plans

A small, fixed set of metrics carries the shop:
- the edge's requests and their duration;
- Checkout duration by outcome;
- Orders settled;
- the oldest Pending Order;
- the quota refusals.

The label is `tenant_id`, never the handle. The control plane exports `tenant_info{tenant_id, tenant, plan, cell, internal}`, with one series per shop that is not deleted. Dashboards and alerts that need a handle or a plan join on it, deduplicated so two control-plane pods during a rollout cannot break the join:

```
* on (tenant_id) group_left (tenant) max by (tenant_id, tenant) (tenant_info{...})
```

Every series from a cell also carries `cell`, copied from a pod label by the PodMonitors.

The lab caps a pooled cell at 20 shops (Phase 5, decision 2). That bounds each tenant-labelled metric at about 20 series per cell, times its other labels.

## Considered Options

- **The handle as the label**: rejected. The worker and the order service's gauge know only ids, so the metrics would be inconsistent. A handle is also an address, which a later phase may let change; an id never changes.
- **Tenant labels on every metric**: rejected. Most series (process, queue, per-route latency) are about a unit, not a shop, and the label would multiply all of them by the shops in the cell.
- **No tenant label; per-shop detail only in logs**: rejected. The noisy-neighbour bound and a plus shop's SLO are statements about one shop's latency and errors over time, which logs cannot alert on.

## Consequences

- Plus shops' Checkout SLO alerts select their tenants through `tenant_info{plan="plus"}` (`deploy/monitoring/config/slo-rules.yaml`), tested with promtool in CI.
- At scale, the blueprint's plan applies: recording rules for the top N shops, and per-shop detail in logs and traces (Phase 7).
- A shop deleted while its series still exist loses its `tenant_info` row; its series then show only an id until they go stale.
