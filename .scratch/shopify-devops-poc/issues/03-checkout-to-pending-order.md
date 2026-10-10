# 03: Checkout to Pending order — retry-safe, one Order per Cart

**What to build:** A Guest buyer checks out their Cart with a chosen Payment scenario and immediately receives a Pending order and an Order token, then reads the Order's status and item snapshot with that token. Retries of the same Checkout return the same Order; a reused Checkout key with a different request, or a second Checkout of an already-ordered Cart, is refused (ADR-0001). This introduces the order service, the `orders` schema with its own identity, the Order token, and the storefront Checkout page with the Payment scenario picker. Orders stay Pending in this ticket; settling them is ticket 04.

**Blocked by:** 02

**Status:** resolved

- [x] Checkout takes Cart token, Checkout key, and Payment scenario (`approve`, `decline`, `slow`); it fetches Cart contents and current prices from the catalog server-side and returns `202` with Order ID and Order token
- [x] In one transaction the order service writes the Pending order, its immutable item snapshot, and one outbox event
- [x] The request hash covers Cart ID and Payment scenario only; the Order stores its source Cart ID under a uniqueness constraint
- [x] Seam-1 test: 100 retries with one Checkout key produce exactly one Order and return the same Order each time
- [x] Seam-1 test: the same Checkout key with a different Cart or Payment scenario returns `409`
- [x] Seam-1 test: a new Checkout key for a Cart that already became an Order returns `409` and creates nothing
- [x] Seam-1 test: reading an Order requires its Order token; a wrong or missing token cannot read it; the token is never stored (HMAC of the order id, ADR-0004)
- [x] Seam-1 test: the catalog identity cannot read or write `orders` tables, and the order identity cannot write `catalog` tables
- [x] Storefront Checkout page offers the Payment scenario picker, shows the Order page afterwards, and starts a fresh Cart
- [x] Order tokens never appear in logs

## Comments

Resolved 2026-10-10. `make test` passes from a wiped stack. New service-HTTP tests cover: 202 Pending order with item snapshot at server-owned prices; 100 concurrent retries producing one Order and one outbox event; reused Checkout key with a changed Cart or Payment scenario (409); second Checkout of an ordered Cart (409, ADR-0001); snapshot unchanged by later Cart edits; Order reads requiring the Order token; mixed-case cart token retries; input errors; database identity isolation; no Order token in order-service logs; the storefront Checkout flow, double submit, and token-gated Order page. Two deliberate breakages (no race recovery, request hash ignored) each failed their test.

Decided in review: Order token is an HMAC of the order id, never stored (ADR-0004); refused Checkouts are "refused", never "rejected" (a Rejected order is a terminal Order); order_app may only append to the outbox. Shared service plumbing now lives in `@shop/service-kit`.

Deferred: storefront log check for `?token=` links (ticket 09; done there).

