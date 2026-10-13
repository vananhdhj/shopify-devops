# 03: A cap on each tenant's Checkouts in flight

**What to build:** The order service admits at most N Checkouts in flight per tenant (by plan); past it, `429 checkout_busy`. The storefront turns that into a "Checkout is busy, try again in a moment" page with `429` and `Retry-After`, never a 500.

**Blocked by:** 01 (deployed)

**Status:** ready-for-agent

- [ ] Per-tenant semaphore in the order service, released on every path (success, refusal, error)
- [ ] Storefront: the busy page, `429`, `Retry-After`
- [ ] Seam-1 test: concurrent Checkouts past a starter shop's cap: the extra ones get the busy page, the others complete, another shop's Checkout is unaffected
