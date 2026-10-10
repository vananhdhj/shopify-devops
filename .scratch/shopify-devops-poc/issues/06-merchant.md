# 06: Merchant — sign in, add products, fulfill Confirmed orders

**What to build:** The Merchant signs in with a password, adds products, lists all Orders, and marks Confirmed orders as Fulfilled. The storefront checks the password against a stored hash and issues a signed httpOnly session cookie; it calls the APIs' admin endpoints with a separate admin service token, so the human password never reaches the APIs.

**Blocked by:** 04

**Status:** resolved

- [x] `make secrets` generates the admin password, its hash, the session signing key, and the admin service token
- [x] Storefront admin pages redirect to sign-in without a valid session
- [x] Merchant can add a product (name, price, starting stock) and see it on the storefront listing
- [x] Merchant can list Orders with their status and mark a Confirmed order as Fulfilled
- [x] Seam-1 test: admin endpoints on both APIs reject requests without the admin service token
- [x] Seam-1 test: marking a Pending or Rejected order as Fulfilled is refused
- [x] Credentials and session cookies never appear in logs

## Comments

- Carried from ticket 04 review: legal status transitions are enforced only by the worker's `WHERE status = 'PENDING'`. When the Merchant's Confirmed → Fulfilled action arrives, enforce the full transition table in the database (e.g. a trigger on `orders.orders.status`) so no code path can make an illegal transition.

Review decisions (2026-10-10), before closing:
- The Merchant session is stateless: a signed expiry bound to the password hash. Signing out clears only that browser's copy; changing the password or rotating SESSION_SECRET signs every session out. A server-side session store (to revoke a single stolen cookie) is out of scope for the POC.
- Admin form posts and sign-in are refused (403) when their Origin names another site, backing up SameSite=Strict, which treats other localhost ports as the same site. Password checking is asynchronous scrypt; there is no attempt limiting, as the generated password is long and random.
- The Merchant's order list puts Confirmed orders first and says when it is truncated (200 per page).
- Not extracted: header-name constants (`@shop/contracts` is type-only) and a shared order-history insert between worker and order service (one statement; a shared order-domain package is not yet justified).

Resolved 2026-10-10. `make test` passes twice from a wiped stack (95 tests). New tests: admin endpoints on both APIs refuse missing or wrong admin service tokens; the Merchant lists Orders and fulfills a Confirmed one (status history recorded); Pending and Rejected orders cannot be fulfilled, and the database trigger refuses illegal status changes for the order identity itself; products added with validation; storefront sign-in (wrong password, tampered cookie, sign-out), admin pages and form posts all refuse visitors without a session and posts from another site; no password, guess, admin token, or session cookie appears in any service's logs.

