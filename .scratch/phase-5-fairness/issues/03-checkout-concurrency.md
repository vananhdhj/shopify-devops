# 03: A cap on each tenant's Checkouts in flight

**What to build:** The order service admits at most N Checkouts in flight per tenant (by plan); past it, `429 checkout_busy`. The storefront turns that into a "Checkout is busy, try again in a moment" page with `429` and `Retry-After`, never a 500.

**Blocked by:** 01 (deployed)

**Status:** resolved

- [ ] Per-tenant semaphore in the order service, released on every path (success, refusal, error)
- [ ] Storefront: the busy page, `429`, `Retry-After`
- [ ] Seam-1 test: concurrent Checkouts past a starter shop's cap: the extra ones get the busy page, the others complete, another shop's Checkout is unaffected

## Comments

Implementation notes (2026-10-13):
- The order service counts each tenant's Checkouts in flight in its process (`InFlight`) against `planLimits[plan].checkoutsInFlight` (starter 3, plus 10, synthetic 3), the plan read from the signed tenant context. Past it: `429`, `Retry-After: 1`, `{"error":"checkout_busy"}`, and `checkouts_busy_total{tenant}`. The slot is taken after the request's cheap checks, before any database work, and released on every path (`finally`).
- `CheckoutError` gains `checkout_busy`, and the storefront's exhaustive switch now must handle it. It answers a busy shop with a "Checkout is busy" page, `429` and `Retry-After`, the Cart kept, never a 500.
  - While a cell rolls, an older storefront can briefly meet a newer order service; it would show its generic error page for this one answer.
- `CHECKOUT_LIMIT_EXEMPT`: none in the cluster. Compose exempts `harbor` and `meadow`, whose contention tests send 100 concurrent Checkouts.

Tests:
- `checkout-concurrency.test.ts`, pure: slots per tenant, release, and tenants apart.
- In Compose: a fresh starter shop's 24 concurrent Checkouts each answer 202 or 429 (some 429, at least 3 accepted, the 429s with `checkout_busy` and `Retry-After: 1`). Harbor's Checkout in the same moment is accepted, and refused Carts then check out one by one (every slot was given back).

`make test` with the cluster stopped: 38 files, 209 tests passed (262 s).

Resolved 2026-10-13 with PR #51 (`33bb703`, digests `7291b88`). The release went through the waves 06:29 to 06:42. Through the ingress, a fresh starter shop (`cap-5ac0c5`) with 8 Carts sent 8 concurrent Checkouts: 4 × 303 (accepted; a slot freed during the burst, so 4 rather than 3) and 4 × 429 with the "Checkout is busy" page. None failed.
