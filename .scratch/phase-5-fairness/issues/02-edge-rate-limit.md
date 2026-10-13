# 02: A request rate limit per tenant in the edge

**What to build:** The edge holds a token bucket per tenant, sized by plan; past it, a request gets `429` with `Retry-After` and never reaches the cell. The bare platform domain is limited per client address. Internal (synthetic) shops are not limited.

**Blocked by:** 01 (deployed)

**Status:** ready-for-agent

- [ ] Token bucket (pure, unit-tested): continuous refill, burst, `Retry-After` in whole seconds
- [ ] `429` text body, `retry-after` header, `router_rate_limited_total{cell,tenant}`
- [ ] Seam-1 test: a starter shop past its burst gets 429s while another shop keeps 200, and recovers after `Retry-After`
- [ ] Cluster: a burst against a test shop through the ingress shows 429s and no 5xx
