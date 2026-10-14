---
status: accepted
---

# A shop is frozen read-only through the tenant context the edge signs

A shop being moved or restored is `MOVING` or `RESTORING` in the registry. The database allows only `ACTIVE → MOVING | RESTORING → ACTIVE`. The edge serves both statuses like `ACTIVE` and signs `ro: true` into the shop's tenant context (as it signs the plan, ADR-0026).

The flag is absent when false, so an unfrozen shop's context is unchanged and units on an earlier release ignore it.

A read-only context is enforced in two places:
- **The cell's APIs** refuse every write (anything but GET, HEAD, OPTIONS) with `503 shop_updating` and `Retry-After: 5`. This happens in the one hook that verifies the tenant context, so no route can forget it. Internal routes carry no tenant context, so the worker's settlement and the move's own endpoints still run.
- **The storefront** answers a frozen shop's form posts with "This shop is updating, try again in a moment" (503) before any API call. Signing in and out stays open, so a Merchant can read their admin.

## Considered Options

- **Pausing the whole shop at the edge** (Phase 6, decision 2): rejected. Buyers would lose browsing for the length of the move.
- **Asking the control plane whether a shop is frozen**, from each unit: rejected. It would put the control plane on every write's path, which ADR-0013 keeps off the buyer's path.
- **Refusing writes in each route**: rejected. A new route could forget it.

## Consequences

- A freeze only holds once every edge and cell runs a release that knows the flag. An earlier edge answers an unknown status as no shop at all (404). This is why the freeze shipped and reached every wave before the move did.
- The freeze reaches the edges within one routing refresh (2 s), which the move waits out before reading the shop.
- Pending Orders keep settling while frozen.
