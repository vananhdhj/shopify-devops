---
status: accepted
---

# Per-tenant limits are kept in each unit's memory, sized by a plan the edge signs

Each limit is enforced where the resource it protects is used, from one table in `@shop/tenancy` (`planLimits`):
- **Request rate**, at the edge: a token bucket per shop (starter 10 a second, burst 30; plus 50 and 150). Over it, `429` with `Retry-After`; the request never reaches the cell. The platform's own address is limited per client address.
- **Checkouts in flight**, in the order service: starter 3, plus 10. Over it, `429 checkout_busy`, which the storefront shows as "Checkout is busy, try again".
- **Products**, in the catalog API: starter 100, plus 5,000. Over it, `409 product_quota`, counted and inserted under a per-shop lock, and shown to the Merchant against their use.
- **Orders admitted into the settlement queue**, by the dispatcher (ADR-0025).

A cell's synthetic shop has its own limit class, `internal`, and is never rate limited.

The plan reaches the cell in the tenant context. The edge reads it from the routing table and signs it in as a limit class. A context from an earlier edge has none and reads as `starter`. No unit asks the control plane for it.

Every counter lives in the process that enforces it.

## Considered Options

- **Shared state in a platform-level Redis**: rejected for now (Phase 5, decision 3). It is exact across replicas, but it puts a new dependency and a round trip on every request through the edge. It would also need a rule for when Redis is down: allow everything, or refuse everything.
- **Asking the control plane for a shop's plan**: rejected. It would make every limited request depend on the control plane, which ADR-0013 keeps off the buyer's path.
- **Quotas at the edge only**: rejected. The edge cannot see a Checkout's duration or a catalog's size, and a single page can cost one request or twenty.

## Consequences

- Exact with one replica of each unit, which is the lab's shape. With N replicas each enforces the full limit: N times the rate and N times the Checkouts. Revisit when the edge or the order service runs more than one replica.
- A limit change is a code change to one table, released through the waves like any other.
- Local test runs exempt only the two seeded shops and the signup pages, whose suites drive them far harder than any buyer (`RATE_LIMIT_EXEMPT`, `CHECKOUT_LIMIT_EXEMPT`, `PRODUCT_QUOTA_EXEMPT`). The cluster exempts nothing.
- The noisy-neighbour experiment (Phase 5 evidence) measures the result: a shop at 10× its rate gets 429s, not 5xx, and the other shops in its cell keep their Checkout latency.
