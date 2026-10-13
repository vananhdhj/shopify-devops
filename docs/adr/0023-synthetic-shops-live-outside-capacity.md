---
status: accepted
---

# Every cell holds a synthetic shop, outside its capacity

A release is gated on a real Checkout in each cell it is about to leave, so every cell holds one **synthetic shop**: an internal shop, `synthetic-<cell>`, that the control plane creates when the cell registers.
- Its catalog is one product that the cell's catalog API adds on the control plane's request, with that cell's own token.
- No password opens it.
- The promoter buys from it through the edge, with the decline payment scenario. That exercises the storefront, the catalog, the order service, and the worker's settlement, and leaves Stock unchanged.

Internal shops do not count against a cell's capacity: not in placement, not in the registration's check, and not in the fleet view's counts. So a dedicated cell with its synthetic shop still takes its one plus shop.

## Considered Options

- **A synthetic Checkout in the canary only, the later waves gated on metrics**: rejected. A quiet cell gives the metrics nothing to measure, so a broken pooled or dedicated cell would pass. Phase 5 also wants a synthetic tenant per cell.
- **Buying from a real shop**: rejected. It writes Orders into a Merchant's shop and depends on that shop's catalog.
- **Counting the synthetic shop in the capacity and raising dedicated cells to 2**: rejected. A plus Merchant's cell would then nominally hold room for a second shop, and placement rules would have to tell the two apart anyway.

## Consequences

- A cell id is at most 20 characters, so `synthetic-` plus the id fits a 30-character handle. Handles starting `synthetic-` are reserved at signup.
- A unique index allows one non-deleted internal shop per cell. The Phase 3 seed path for the canary's shop is retired, so a fresh cluster cannot get two; the existing `canary` shop counts as the canary cell's synthetic shop.
- A cell's registration that reaches an older control plane creates no synthetic shop until the cell registers again on its next sync (seen once in ticket 02's rollout).
- A halted release counts the real tenants it reached, internal shops excluded. The drill's canary held only its synthetic shop, so the count was 0.
