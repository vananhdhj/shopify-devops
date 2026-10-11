# 02: Merchant credentials in the control plane

**What to build:** Merchant passwords live only in the registry. The storefront checks a sign-in by asking the control plane, and a session is bound to the shop's credential version, which the router carries in the tenant context. `MERCHANT_CREDENTIALS` and `deploy/base/tenants.json` are retired.

**Blocked by:** 01 (merged to main)

**Status:** resolved

- [x] `POST /internal/merchant-sign-ins` (tenant id, password) answers yes or no, refused without `PLATFORM_STOREFRONT_TOKEN`; the hash never leaves the control plane
- [x] The tenant context carries the credential version; the session signature covers tenant id, expiry, and that version
- [x] Storefront sign-in calls the control plane; a control-plane outage blocks new sign-ins with a clear message and leaves existing sessions working
- [x] `MERCHANT_CREDENTIALS`, `MERCHANT_PASSWORD_*` handling in the storefront, and the static tenant file are removed; the router always reads the registry
- [x] Seam-1 tests: Phase 1's per-shop password and session tests pass against the registry; bumping a shop's credential version signs its sessions out within one refresh; the sign-in endpoint refuses without the token

## Comments

Implementation notes (2026-10-11):
- `MERCHANT_CREDENTIALS` stays as the platform seed's input for the two Phase 1 shops (their hashes); the storefront no longer reads it, and `secrets.sh` names those two shops itself now that the tenant file is gone. Shops that sign up (ticket 03) choose their own password at the control plane.
- The tenant context gains `cv` (`TenantContext` in `@shop/tenancy`); `parseTenantTable` and the router's static mode are removed. The cluster manifests still mount the old file until ticket 05.
- Sign-in answers "unavailable" both when the control plane is unreachable and when it reports a newer credential version than the router's (not yet refreshed), so a session is never issued already out of date.

Resolved 2026-10-11. `make test` passes (28 files, 148 tests). New tests: the sign-in check refuses callers without the storefront token and answers only yes or no (right, wrong, and unknown tenant); bumping a shop's credential version signs its session out within one refresh, and a fresh sign-in works again; a suspended shop cannot be signed in to; with `platform-api` stopped, an existing session keeps working and a new sign-in shows "isn't possible right now".
