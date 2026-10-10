# 02: Cart — a Guest buyer's Cart that survives reloads and replicas

**What to build:** A Guest buyer can add products to a Cart, change quantities, and remove items without an account. The Cart lives server-side in the catalog, is identified by a cart token held by the storefront, and is served identically by any storefront or API replica. Adding to a Cart never deducts stock.

**Blocked by:** 01

**Status:** resolved

- [x] Catalog-cart API supports create Cart, get Cart, and set a Cart item's quantity (zero removes it); quantity is always positive in storage
- [x] Storefront shows a Cart page and add-to-cart actions; the Cart survives a page reload
- [x] Seam-1 test: a Cart created through one API replica is readable, with identical contents, through a second replica
- [x] Seam-1 test: adding items to a Cart leaves product stock unchanged
- [x] Unknown cart tokens and unknown products return clear client errors, not server errors

## Comments

Resolved 2026-10-10. `make test` passes from a wiped stack: 31 service-HTTP tests, including Cart create/read/set-quantity, 404/400 client errors, Stock unchanged by Cart edits, a Cart read through a second API replica, and the storefront form flow (add from listing or product page, set, remove, stale cookie, refused product shown to the Guest buyer).

Decided in review: the Cart id doubles as its token, and every API logs requests by route template rather than raw URL so tokens and ids stay out of logs; one shop currency (USD) is enforced by a database constraint; per-line quantity is 0 to 99.

Accepted: two simultaneous "add" clicks from one Guest buyer can lose an increment (add is read-then-set). The storefront holds no Cart state of its own (the token is in the cookie), so only the API replica case is tested.

