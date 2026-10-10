# 02: Cart — a Guest buyer's Cart that survives reloads and replicas

**What to build:** A Guest buyer can add products to a Cart, change quantities, and remove items without an account. The Cart lives server-side in the catalog, is identified by a cart token held by the storefront, and is served identically by any storefront or API replica. Adding to a Cart never deducts stock.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Catalog-cart API supports create Cart, get Cart, and set a Cart item's quantity (zero removes it); quantity is always positive in storage
- [ ] Storefront shows a Cart page and add-to-cart actions; the Cart survives a page reload
- [ ] Seam-1 test: a Cart created through one API replica is readable, with identical contents, through a second replica
- [ ] Seam-1 test: adding items to a Cart leaves product stock unchanged
- [ ] Unknown cart tokens and unknown products return clear client errors, not server errors
