# 03: Two shops — per-tenant storefront, Merchant credentials, and sessions

**What to build:** Harbor Goods and Meadow Supply each work as a complete shop at their own address: the storefront shows the shop's name and catalog, and each Merchant signs in with their own password to a session that is valid only at their shop.

**Blocked by:** 02

**Status:** resolved

- [x] `make secrets` generates a Merchant password per tenant and `MERCHANT_CREDENTIALS`; `ADMIN_PASSWORD` and `ADMIN_PASSWORD_HASH` are retired
- [x] The storefront shows the tenant's display name; product, Cart, Checkout, Order, and admin pages work at both addresses
- [x] Merchant sign-in checks the current tenant's hash; the session signature covers the tenant id
- [x] Storefront log lines carry the tenant
- [x] Isolation suite, storefront: each address shows only its own products and name; one shop's Merchant password and session cookie do not work at the other; an Order link from one shop shows nothing at the other
- [x] Storefront seam-1 tests run through the router at `harbor`'s address

## Comments

Implementation notes (2026-10-11):
- `MERCHANT_CREDENTIALS` is `<tenant id>=<scrypt hash>,...`. `make secrets` hashes only shops missing from it and drops shops no longer in the tenant table, so a re-run leaves the file unchanged and sessions survive. `cluster-secrets.sh` keeps the plaintext `MERCHANT_PASSWORD_*` lines out of the cluster.
- The session signature covers tenant id, expiry, and that shop's password hash, so changing one shop's password signs out only that shop's sessions.
- The root layout reads the shop from the tenant context, so every page now renders per request (the static not-found page became dynamic).
- Found while testing: a worker crash when PostgreSQL dropped connections (a test restarts it). pg-pool listens for client errors only while a client is idle; a connection that died while checked out, or in the same socket read as its handover, emitted `error` with no listener and killed the process. Tenancy widened that window, since every settle step now runs in a tenant transaction. Fixed in `createPool` (a listener for every client's whole life; queries still fail and broken clients are discarded) and in `withTransaction` (a failed rollback no longer hides the original error). A new test cuts the order identity's connections forty times while twenty Orders settle; it crashed the worker before the fix and passes after.

Resolved 2026-10-11. `make test` passes from a wiped stack (26 files, 139 tests). New tests: each address shows its own shop name and only its own products; another shop's product page is a 404; one shop's Merchant password fails at the other, and a session cookie carried to the other shop's address is sent to sign-in; an Order link from one shop is a 404 at the other; the worker survives repeated connection cuts and settles every Order with Stock unchanged.
