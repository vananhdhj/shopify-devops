# 06: The tenant dimension, the cell label, continuous synthetic Checkouts

**What to build:** Five metrics gain a `tenant` label, every cell unit's metrics a `cell` label, and the promoter buys from every cell's synthetic shop every 30 s with its own metrics and an alert.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `router_requests_total{cell,tenant,code_class}`, `router_request_duration_seconds{cell,tenant}`, `checkout_duration_seconds{tenant,outcome}`, `orders_settled_total{tenant,outcome}`, `orders_oldest_pending_age_seconds{tenant}`
- [ ] PodMonitors add `cell` from a pod label set by each cell's kustomization
- [ ] Continuous synthetic Checkouts: `synthetic_checkout_total{cell,outcome}`, `synthetic_checkout_seconds{cell}`; alert `SyntheticCheckoutFailing`
- [ ] Seam-1 test: the labels appear; cluster: every cell's synthetic series has samples
