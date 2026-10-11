# 02: Merchant credentials in the control plane

**What to build:** Merchant passwords live only in the registry. The storefront checks a sign-in by asking the control plane, and a session is bound to the shop's credential version, which the router carries in the tenant context. `MERCHANT_CREDENTIALS` and `deploy/base/tenants.json` are retired.

**Blocked by:** 01 (merged to main)

**Status:** ready-for-agent

- [ ] `POST /internal/merchant-sign-ins` (tenant id, password) answers yes or no, refused without `PLATFORM_STOREFRONT_TOKEN`; the hash never leaves the control plane
- [ ] The tenant context carries the credential version; the session signature covers tenant id, expiry, and that version
- [ ] Storefront sign-in calls the control plane; a control-plane outage blocks new sign-ins with a clear message and leaves existing sessions working
- [ ] `MERCHANT_CREDENTIALS`, `MERCHANT_PASSWORD_*` handling in the storefront, and the static tenant file are removed; the router always reads the registry
- [ ] Seam-1 tests: Phase 1's per-shop password and session tests pass against the registry; bumping a shop's credential version signs its sessions out within one refresh; the sign-in endpoint refuses without the token

## Comments
