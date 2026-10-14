---
status: accepted
---

# A tenant move copies, freezes, and verifies, and Pending Orders settle before the copy

The control plane moves one shop between cells as a resumable lifecycle workflow (`platform-worker`, outbox action `move`). Each step it finishes is recorded, with its counts, so a restarted worker carries on from the last one:
1. **Freeze**: the operator's request sets the shop `MOVING`, served read-only (ADR-0029). The target cell counts as taken from the request, so no signup can fill it meanwhile. A move into a dedicated cell makes the shop plus.
2. **Drain**: after a grace of 5 s (longer than an edge's routing refresh and a write in flight), the worker waits up to 60 s for the shop's Pending Orders to settle in the source cell.
3. **Copy**: export the shop from the source through narrow per-cell functions (ADR-0012's pattern), and import it into the target, keeping ids.
4. **Verify**: every table's row count and md5 in the target must equal the export's, and the source's must not have changed since.
5. **Switch**: the shop's cell, plan, and `ACTIVE`, in one transaction. The edges route it to the target from their next refresh.
6. **Purge**: after the grace again, the source is purged and verified empty.

Any failure before the switch undoes the move. The shop is unfrozen in the source first, untouched, and only then is its copy purged from the target, retried until that cell answers.

Pending Orders settle where they were placed, during the drain. An Order exported while still Pending would also be settled by the source's worker, which holds its job: its payment would run twice. A move whose Orders do not settle within 60 s is undone.

## Considered Options

- **Logical replication filtered by tenant** (Phase 6, decision 1): rejected for now. It needs replication privileges and network paths between cells' databases, and many more moving parts, for a shorter freeze that the lab's shops, of a few thousand rows, do not need.
- **Moving Pending Orders with the shop**, to settle in the target: rejected. Both cells' workers would hold the same Order, and only the source's dispatcher knows it has dispatched it.
- **Undoing by restoring the source**: not needed. Nothing is written to the source before the switch, so unfreezing it is the undo.

## Consequences

- A buyer can browse throughout. Cart and Checkout are refused for about the grace plus the drain plus the copy: 5.2 s for the test shop in Compose.
- Credentials signed with a cell's own secret do not survive the move. A buyer's link to an Order placed before it no longer opens (the Order token), and the Merchant signs in again (the session). Both are recorded as Phase 6 gaps.
- The copy is held in the worker's memory in one request per API, which is enough for the lab's shops and not for large ones.
