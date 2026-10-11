# 03: Signup and provisioning

**What to build:** A merchant signs up at the bare platform address and gets a working shop without any operator step. The router sends `shop.localhost` to the control plane's signup pages; `POST /signups` creates a `PROVISIONING` tenant and a provisioning event; `platform-worker` places it in `cell-1`, activates it, and checks it through the router.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Signup page and form at the bare base domain, served by `platform-api` through the router; a status page that redirects to the shop's sign-in once it is `ACTIVE`
- [ ] `POST /signups`: handle, name, password validation (DNS label, 3–30 characters, reserved handles, password ≥ 12); idempotency key with request hash; one transaction for tenant, signup record, event, and outbox
- [ ] `platform-worker`: claims lifecycle events with `SKIP LOCKED`; provisioning steps are idempotent and each writes a `tenant_events` row; the post-activation check through the router is retried with backoff and recorded
- [ ] Seam-1 tests: signup → `ACTIVE` within 10 s → Merchant sign-in → add a product → a buyer Checkout is Confirmed; 20 concurrent signups with one key make one tenant; a reused key with another handle, a taken handle, an invalid or reserved handle, and a short password are refused; killing `platform-worker` mid-provisioning resumes with no duplicate tenant or events

## Comments
