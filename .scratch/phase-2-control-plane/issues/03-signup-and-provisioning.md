# 03: Signup and provisioning

**What to build:** A merchant signs up at the bare platform address and gets a working shop without any operator step. The router sends `shop.localhost` to the control plane's signup pages; `POST /signups` creates a `PROVISIONING` tenant and a provisioning event; `platform-worker` places it in `cell-1`, activates it, and checks it through the router.

**Blocked by:** 02

**Status:** resolved

- [x] Signup page and form at the bare base domain, served by `platform-api` through the router; a status page that redirects to the shop's sign-in once it is `ACTIVE`
- [x] `POST /signups`: handle, name, password validation (DNS label, 3–30 characters, reserved handles, password ≥ 12); idempotency key with request hash; one transaction for tenant, signup record, event, and outbox
- [x] `platform-worker`: claims lifecycle events with `SKIP LOCKED`; provisioning steps are idempotent and each writes a `tenant_events` row; the post-activation check through the router is retried with backoff and recorded
- [x] Seam-1 tests: signup → `ACTIVE` within 10 s → Merchant sign-in → add a product → a buyer Checkout is Confirmed; 20 concurrent signups with one key make one tenant; a reused key with another handle, a taken handle, an invalid or reserved handle, and a short password are refused; killing `platform-worker` mid-provisioning resumes with no duplicate tenant or events

## Comments

Implementation notes (2026-10-11):
- `platform-api`'s public listener (:8100) serves the signup form, `POST /signups` (an HTML form gets pages and a 303 to a status page; a JSON client gets 202 and a status URL), and `GET /signups/:id`, which redirects to the shop's sign-in once it is active. The router forwards the bare base domain there, without a tenant context; `reply-from` now proxies to absolute URLs (two upstreams), with no fixed `base`.
- Signup follows the Checkout-key rule: same key and request return the same shop; the request hash covers handle and name, not the password. A race on the same key or handle resolves to the winner's committed signup. Cross-site form posts are refused.
- `platform-worker` claims due lifecycle events by leasing them (30 s), so no transaction stays open while a step calls the router; a crashed worker's lease lapses and the event comes due again. Provisioning steps check state before acting and each records its event once; failed router checks are recorded as `check_failed` and retried with capped exponential backoff.
- Both listeners share one Prometheus registry; `observeRequests` now reuses an existing request histogram in a registry instead of registering a second.

Resolved 2026-10-11. `make test`: 158 of 160 passed; the two failures were the Phase 1 router test still expecting the bare domain's 404 (updated: it now expects the signup pages) and the catalog shutdown test timing out under CPU contention (load average 37 on 6 CPUs while the k3d cluster restarted pods); both pass on a re-run. New tests: signup → ACTIVE in under 10 s → Merchant sign-in → product added → buyer order Confirmed, with the audit trail in order; the form walks a browser to the shop's sign-in page; cross-site form posts are refused; 20 concurrent retries make one shop and a changed retry is refused; taken, invalid, too-short, and reserved handles, short passwords, and empty names are refused; with the worker stopped a shop stays PROVISIONING and its address answers 503, and after restart every step is recorded once; two workers provision six shops with each step once.
