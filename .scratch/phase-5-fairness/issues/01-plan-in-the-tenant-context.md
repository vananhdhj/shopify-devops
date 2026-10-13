# 01: The plan in the tenant context, the plan limits, a pooled cap of 20

**What to build:** Every unit learns a request's plan without asking the control plane: the routing table carries each shop's plan and the edge signs it into the tenant context. One shared module holds the per-plan limits every later ticket reads. pool-1's capacity drops to 20.

**Blocked by:** none

**Status:** in review

- [ ] Routing table entries carry `plan` (and `internal`); the tenant context gains an optional `plan`, absent meaning `starter`, so units on the previous release keep verifying contexts
- [ ] `@shop/tenancy` (or contracts) exports the plan limits table (requests, burst, Checkouts in flight, products, admitted Orders) for `starter`, `plus`, `internal`
- [ ] pool-1 registers with capacity 20 on the cluster (Compose keeps 10,000 for test runs)
- [ ] Tests: the context round-trips the plan; an old-format context still verifies; the limits table

## Comments

Implementation notes (2026-10-13):
- `@shop/tenancy`:
  - `LimitClass` (`starter`, `plus`, `internal`), and `TenantContext.plan`, signed as `p`.
  - A context without `p`, from an edge of an earlier release, reads as `starter`; an unknown class is refused. Units of the previous release ignore the extra field, so either order of rollout verifies.
  - `planLimits`, the one table the edge, the order service, the catalog API, and the worker will read; `limitClassOf(route)` (internal first, then plus, otherwise starter).
- The routing table carries `plan` and `internal`. The edge signs `limitClassOf(route)` into every context; a table saved by an earlier release lacks both fields and reads as `starter`.
- `tenantOf(req)` in service-kit returns the full context, plan included.
- pool-1 registers with capacity 20 on the cluster (dev and staging); it holds 4 real shops. Compose keeps 10,000 for test runs.

Tests: `tenant-context.test.ts` (pure): every class round-trips, an old-format context reads as starter, an unknown class is refused, the route mapping, plus above starter on every limit, synthetic shops never rate limited. `registry.test.ts`: the routing table carries `internal: false` for the seeded shops and `internal: true` for `synthetic-pool-1`. `make test` with the cluster stopped: 36 files, 203 tests passed.

Rollout: every image rebuilds (a shared package changed), so a release through the waves. The merge commit's only manifest change is pool-1's capacity, which the previous image's registration hook already sends.
