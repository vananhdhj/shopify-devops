# 03: Two shops — per-tenant storefront, Merchant credentials, and sessions

**What to build:** Harbor Goods and Meadow Supply each work as a complete shop at their own address: the storefront shows the shop's name and catalog, and each Merchant signs in with their own password to a session that is valid only at their shop.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `make secrets` generates a Merchant password per tenant and `MERCHANT_PASSWORD_HASHES`; `ADMIN_PASSWORD` and `ADMIN_PASSWORD_HASH` are retired
- [ ] The storefront shows the tenant's display name; product, Cart, Checkout, Order, and admin pages work at both addresses
- [ ] Merchant sign-in checks the current tenant's hash; the session signature covers the tenant id
- [ ] Storefront log lines carry the tenant
- [ ] Isolation suite, storefront: each address shows only its own products and name; one shop's Merchant password and session cookie do not work at the other; an Order link from one shop shows nothing at the other
- [ ] Storefront seam-1 tests run through the router at `harbor`'s address

## Comments
