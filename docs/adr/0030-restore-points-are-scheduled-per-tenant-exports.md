---
status: accepted
---

# Restore points are scheduled per-tenant exports, kept on the platform worker's volume

Every 15 minutes the platform worker exports every ACTIVE shop, synthetic shops aside, with the move's export functions. Each export is the shop's rows and their checksums, written to a volume that only the worker mounts (they hold customer data). The newest 8 are kept per shop, and a deleted shop's exports are removed with it. Each export is recorded in the registry's database, so the operator lists them without the volume. The operator can also take one on demand.

A restore re-imports one chosen export:
1. Freeze the shop (`RESTORING`, ADR-0029) and drain its Pending Orders, like a move.
2. Save the shop as it is now, as a pre-restore export.
3. Purge the shop in its cell, import the export, and verify every table against the export's checksums.
4. Unfreeze.

Any failure after the save puts the pre-restore export back before unfreezing.

Exports are lifecycle events with a loop of their own. At most 20 are asked for per tick and an operator's export goes first, so a round never holds up a signup, a deletion, a move, or a restore.

## Considered Options

- **Point-in-time recovery of the cell's PostgreSQL** (a base backup and WAL archiving, replayed into an isolated scratch database, from which one shop is exported and re-imported). **Deferred, not rejected** (Phase 6, decision 3). It restores to any moment, but every cell would gain archiving, disk, and memory that the 16 GB laptop cannot spare. The README records it as the change to make when the lab moves (Phase 8's cloud run).
- **A whole-cell restore**: rejected. It would roll back every other shop in the cell.

## Consequences

- A restore point is only as fine as the interval. Everything the shop changed since its export is lost, Orders included, and the operator's command says so.
- An export reads the catalog and the Orders in two statements, which are not one snapshot. An export from before a migration that adds a column would import that column as NULL.
- Exports are on one volume of the lab's one node, unencrypted. Encryption and copies off the host belong to Phases 7 and 8.
