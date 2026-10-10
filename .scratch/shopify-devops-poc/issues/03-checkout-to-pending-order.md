# 03: Checkout to Pending order — retry-safe, one Order per Cart

**What to build:** A Guest buyer checks out their Cart with a chosen Payment scenario and immediately receives a Pending order and an Order token, then reads the Order's status and item snapshot with that token. Retries of the same Checkout return the same Order; a reused Checkout key with a different request, or a second Checkout of an already-ordered Cart, is refused (ADR-0001). This introduces the order service, the `orders` schema with its own identity, the Order token, and the storefront Checkout page with the Payment scenario picker. Orders stay Pending in this ticket; settling them is ticket 04.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Checkout takes Cart token, Checkout key, and Payment scenario (`approve`, `decline`, `slow`); it fetches Cart contents and current prices from the catalog server-side and returns `202` with Order ID and Order token
- [ ] In one transaction the order service writes the Pending order, its immutable item snapshot, and one outbox event
- [ ] The request hash covers Cart ID and Payment scenario only; the Order stores its source Cart ID under a uniqueness constraint
- [ ] Seam-1 test: 100 retries with one Checkout key produce exactly one Order and return the same Order each time
- [ ] Seam-1 test: the same Checkout key with a different Cart or Payment scenario returns `409`
- [ ] Seam-1 test: a new Checkout key for a Cart that already became an Order returns `409` and creates nothing
- [ ] Seam-1 test: reading an Order requires its Order token; a wrong or missing token cannot read it; the token is stored only as a hash
- [ ] Seam-1 test: the catalog identity cannot read or write `orders` tables, and the order identity cannot write `catalog` tables
- [ ] Storefront Checkout page offers the Payment scenario picker, shows the Order page afterwards, and starts a fresh Cart
- [ ] Order tokens never appear in logs
