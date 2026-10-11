---
status: accepted
---

# One admin service token for both APIs

The storefront is the only caller of the admin endpoints, acting for the signed-in Merchant, and it presents the same `ADMIN_SERVICE_TOKEN` to the catalog-cart API and the order service. The token identifies the caller, not the target API: one caller, one authority, one credential. Its job is to keep the Merchant's password away from the APIs, and one token is enough for that. Service tokens in this repo are split by caller and purpose (the worker has its own internal inventory token), not by target.

## Considered Options

- **One admin token per API**: rejected for the POC; the storefront would still hold both, so a leak from the storefront, the realistic target, exposes both APIs anyway. It also adds a secret to generate, wire and rotate.

## Consequences

- Both APIs hold the token, so a compromised catalog-cart API can call the order service's admin endpoints (list and fulfill Orders), and the reverse.
- Rotation is one rerun of `make secrets` and a restart of the storefront and both APIs.
- Splitting later means two keys in `scripts/secrets.sh`, Compose and the three manifests, plus `apps/storefront/lib/admin-api.ts` picking the token by target.

## Amended 2026-10-11: one token per cell, and it never names a tenant

With many shops on the platform, the token still identifies one caller, the storefront, and is now understood as one token per cell: a cell's token is never valid in another cell (blueprint, Phase 3). It grants no tenant: the shop an admin request acts on comes only from the signed tenant context (ADR-0011), and each Merchant signs in with their own shop's password to a session valid only at that shop. A leaked token therefore exposes the admin endpoints of one cell, for tenants whose context the holder can also present.
