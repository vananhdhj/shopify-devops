# 02: A read-only freeze for one shop

**What to build:** Registry statuses `MOVING` and `RESTORING`; the edge signs a read-only flag into the shop's tenant context; the cell's APIs refuse its writes with `503 shop_updating`; the storefront shows "This shop is updating, try again in a moment" for cart and Checkout. Browsing keeps working.

**Blocked by:** none

**Status:** resolved

- [x] Migration: the transition trigger allows `ACTIVE ↔ MOVING` and `ACTIVE ↔ RESTORING`; routing serves both
- [x] `ro` in the tenant context (absent: false); the edge sets it for `MOVING`/`RESTORING`
- [x] Catalog API and order service refuse writes for a read-only context (`503 shop_updating`); the worker's internal settlement is unaffected
- [x] Storefront: the updating page for cart, Checkout, and Merchant writes
- [x] Tests: a frozen shop browses (200) and refuses cart and Checkout with the page; a Pending Order still settles; another shop is unaffected

## Comments

Implementation notes (2026-10-14):
- Migration `20261014000205` (platform, expand only): the status check gains `MOVING` and `RESTORING`; the transition trigger allows `ACTIVE → MOVING | RESTORING → ACTIVE` and nothing else out of them (not to `SUSPENDED`, `DELETING`, or each other). Routing already carries every status but `DELETED`.
- Tenant context: `readOnly`, signed as `ro: true` only when true, so a writable shop's context is byte-for-byte what it was; any other value of `ro` makes the context invalid. Units on an earlier release ignore it.
- The edge serves `MOVING` and `RESTORING` like `ACTIVE`, signing `readOnly`. The previous edge answers them 404 (an unknown status), so a freeze must wait for this edge (ticket 03 comes after this release).
- The cell's APIs: the tenant-context hook (`@shop/service-kit`) refuses every method but `GET`, `HEAD`, `OPTIONS` for a read-only context with `503 {"error":"shop_updating"}` and `Retry-After: 5`: one place, so no write route can forget it. Internal routes (the worker's inventory effects, the move's endpoints) carry no tenant context and are unaffected, so Pending Orders settle.
- The storefront's proxy answers a read-only shop's form posts with a 503 page, "This shop is updating, try again in a moment", before any API call. Signing in and out (`/admin/session`) stays open: it writes nothing in the cell, and the control plane's sign-in check accepts a frozen shop, so a Merchant can read their admin.
- The fleet view counts `MOVING` and `RESTORING`; `make fleet` shows them as FROZEN.
- Also here, ticket 01's slow Order import (`20261014000109`, see ticket 01).

Tests:
- `tenant-context.test.ts`, pure: `readOnly` round-trips, is absent from a writable shop's payload, and a non-boolean `ro` is refused.
- `freeze.test.ts` (Compose): Meadow set `MOVING` with an Order still Pending (slow payment). The Order settles while frozen. The home page, a product, the Cart, and the Checkout form answer 200. Cart adds, Checkout, and a Merchant's product add answer the 503 updating page with `Retry-After` and leave the Cart as it was. The Merchant can sign in and read the admin. The APIs answer `shop_updating` to a read-only context's writes and 200 to its reads. Harbor's Cart adds go through. Every way out of `MOVING` but `ACTIVE` is refused. Once unfrozen, Meadow takes writes again.

`make test CELLS=2` with the cluster stopped: 44 files, 234 tests passed (321 s).

Resolved 2026-10-14 with PR #60 (`4bd0c23`). The release, every image, went through the waves with no human step: canary soaked from 22:34, pool-1 from 22:41 (302 s, 20 synthetic Checkouts), dedicated-1 reached at 22:48 UTC. On the cluster, through the ingress: `nn-quiet-1-86d161` (pool-1) set `MOVING` in the registry answered its home page 200 and a Cart add 503 with "This shop is updating, try again in a moment", then 303 again once set back to `ACTIVE`.
