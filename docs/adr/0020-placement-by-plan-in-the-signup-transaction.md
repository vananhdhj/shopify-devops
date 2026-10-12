---
status: accepted
---

# A shop is placed by its plan inside the signup transaction

A shop's cell is chosen when the shop is created, in the same transaction as the tenant and its signup record:

- A `starter` shop goes to the registered pooled cell with the fewest shops that still has room.
- A `plus` shop goes to a registered dedicated cell holding no shop. A dedicated cell's capacity is always 1.
- Only shops flagged internal (the platform's synthetic shop) go to the canary.

The transaction first locks every registered cell of the role (`SELECT … FOR UPDATE`) and then counts their shops, so two placements of the same role run one after the other. When no cell has room, the transaction rolls back and the signup is refused at once with 409 `no_capacity`. Nothing is written. Capacity counts every shop that is not deleted, so deleting a dedicated cell's shop frees the cell.

A shop created without a cell (the synthetic shop, entered by the seed) is placed by provisioning, which retries until a cell of its role has registered.

## Considered Options

- **Place during provisioning, after the signup is accepted**: rejected. A signup could be accepted and then fail minutes later for lack of room, and the Merchant would learn of it on a status page instead of in the answer to the request.
- **Queue a plus signup until a dedicated cell is free**: rejected for now. A queue needs a promise of when a cell will be free, and none exists. Adding a dedicated cell is a pull request (ADR-0019), not an automatic step.
- **No lock; count, insert, and recheck afterwards**: rejected. Two signups racing for the last dedicated cell would both pass the count. A test runs six concurrent plus signups against one free dedicated cell, and exactly one is placed.

## Consequences

- Signups of the same plan run one at a time through placement. That is fine at the lab's rate, but a busy pooled tier would need a cheaper counter (a per-cell shop count updated in the same transaction).
- `no_capacity` is a normal answer of the signup API and form, not an error. The fleet view shows how full each cell is, so the operator can add a cell before it is needed.
- A shop's cell never changes after placement. Moving a shop between cells is Phase 6's work.
