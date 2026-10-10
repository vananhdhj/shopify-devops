# 06: Merchant — sign in, add products, fulfill Confirmed orders

**What to build:** The Merchant signs in with a password, adds products, lists all Orders, and marks Confirmed orders as Fulfilled. The storefront checks the password against a stored hash and issues a signed httpOnly session cookie; it calls the APIs' admin endpoints with a separate admin service token, so the human password never reaches the APIs.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] `make secrets` generates the admin password, its hash, the session signing key, and the admin service token
- [ ] Storefront admin pages redirect to sign-in without a valid session
- [ ] Merchant can add a product (name, price, starting stock) and see it on the storefront listing
- [ ] Merchant can list Orders with their status and mark a Confirmed order as Fulfilled
- [ ] Seam-1 test: admin endpoints on both APIs reject requests without the admin service token
- [ ] Seam-1 test: marking a Pending or Rejected order as Fulfilled is refused
- [ ] Credentials and session cookies never appear in logs

## Comments

- Carried from ticket 04 review: legal status transitions are enforced only by the worker's `WHERE status = 'PENDING'`. When the Merchant's Confirmed → Fulfilled action arrives, enforce the full transition table in the database (e.g. a trigger on `orders.orders.status`) so no code path can make an illegal transition.
