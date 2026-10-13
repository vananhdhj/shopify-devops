# 02: A read-only freeze for one shop

**What to build:** Registry statuses `MOVING` and `RESTORING`; the edge signs a read-only flag into the shop's tenant context; the cell's APIs refuse its writes with `503 shop_updating`; the storefront shows "This shop is updating, try again in a moment" for cart and Checkout. Browsing keeps working.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Migration: the transition trigger allows `ACTIVE ↔ MOVING` and `ACTIVE ↔ RESTORING`; routing serves both
- [ ] `ro` in the tenant context (absent: false); the edge sets it for `MOVING`/`RESTORING`
- [ ] Catalog API and order service refuse writes for a read-only context (`503 shop_updating`); the worker's internal settlement is unaffected
- [ ] Storefront: the updating page for cart, Checkout, and Merchant writes
- [ ] Tests: a frozen shop browses (200) and refuses cart and Checkout with the page; a Pending Order still settles; another shop is unaffected
