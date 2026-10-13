# 02: A request rate limit per tenant in the edge

**What to build:** The edge holds a token bucket per tenant, sized by plan; past it, a request gets `429` with `Retry-After` and never reaches the cell. The bare platform domain is limited per client address. Internal (synthetic) shops are not limited.

**Blocked by:** 01 (deployed)

**Status:** in review

- [ ] Token bucket (pure, unit-tested): continuous refill, burst, `Retry-After` in whole seconds
- [ ] `429` text body, `retry-after` header, `router_rate_limited_total{cell,tenant}`
- [ ] Seam-1 test: a starter shop past its burst gets 429s while another shop keeps 200, and recovers after `Retry-After`
- [ ] Cluster: a burst against a test shop through the ingress shows 429s and no 5xx

## Comments

Implementation notes (2026-10-13):
- `RateLimiter` (`apps/router/src/rate-limit.ts`): one token bucket per key in the edge's memory (decision 3). It refills continuously, holds at most `burst` tokens, and a refused request gets the whole seconds until a token is back. An unlimited class is never limited. Buckets idle for a minute are dropped; at the plans' rates they would be full by then anyway.
- The edge keys a shop's bucket by its tenant id, with its class's limits from `planLimits` (ticket 01; synthetic shops are unlimited). The platform's own address (signup pages) is keyed by client address at a starter shop's rate. The client address is the one Traefik adds to `X-Forwarded-For`: the edge trusts exactly one proxy hop.
- Over the limit: `429`, `Retry-After`, "Too many requests to this shop. Try again in N s.", and `router_rate_limited_total{cell,tenant}`. The request never reaches the cell.
- `RATE_LIMIT_EXEMPT` names handles (and `platform`) never limited. The cluster sets none. Compose exempts `harbor`, `meadow`, and `platform`, which the suites drive far harder than buyers; every other shop, fresh test shops included, gets its plan's limits there. A scale factor was tried first and dropped: a scaled burst (600) cannot be exhausted by a test.

Tests:
- `rate-limit.test.ts`, pure: the burst, the sustained rate, per-key buckets, refill capped at the burst, the idle sweep, unlimited classes.
- In Compose: a fresh starter shop sent 60 concurrent requests gets 429s for at least the excess over its burst, each with `Retry-After` and the body, and never a 5xx. Meadow keeps 200, the shop is served again after the wait, and the counter is labelled with the shop.

`make test` with the cluster stopped: 36 files passed. `lifecycle.test.ts` timed out once (30 s) in a run that took 736 s against the usual 380, on a starved host. Run alone with the rate-limit file it passed (11 tests), and the edge's counter showed only the rate-limit test's shop limited.
