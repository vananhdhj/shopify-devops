# 01: The plan in the tenant context, the plan limits, a pooled cap of 20

**What to build:** Every unit learns a request's plan without asking the control plane: the routing table carries each shop's plan and the edge signs it into the tenant context. One shared module holds the per-plan limits every later ticket reads. pool-1's capacity drops to 20.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Routing table entries carry `plan` (and `internal`); the tenant context gains an optional `plan`, absent meaning `starter`, so units on the previous release keep verifying contexts
- [ ] `@shop/tenancy` (or contracts) exports the plan limits table (requests, burst, Checkouts in flight, products, admitted Orders) for `starter`, `plus`, `internal`
- [ ] pool-1 registers with capacity 20 on the cluster (Compose keeps 10,000 for test runs)
- [ ] Tests: the context round-trips the plan; an old-format context still verifies; the limits table
