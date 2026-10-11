---
status: accepted
---

# Deleting a shop purges it from the cell and verifies nothing is left

Deletion is an operator action that stops routing at once (`DELETING`) and asks the lifecycle worker to remove the shop's data. The worker calls each cell API's purge endpoint (refused without the cell token, which only the control plane holds), which runs a narrow `SECURITY DEFINER` function per schema, the ADR-0012 pattern: it deletes exactly one tenant's rows in dependency order and reports what it removed and what is left. The order service is purged before the catalog, so no settle job can load the shop's Orders afterwards. A settle job that loaded one just before may still write an Inventory effect, so a second pass follows after a grace period; the shop becomes `DELETED` only when a pass deletes nothing and all eight tenant-owned tables hold no row of it. Every pass and the final verification are recorded in the registry's audit trail.

## Considered Options

- **Give the runtime identities DELETE on every table**: rejected; one bug or one stolen credential could delete any shop's rows, and nothing would prove a deletion complete.
- **One pass, no verification**: rejected; an in-flight settle job can leave a row behind, and "deleted" would be a claim, not a checked fact.
- **Soft deletion (flag the tenant, keep its rows)**: rejected; a deleted shop's customer data must actually be gone from the cell.

## Consequences

- A deletion takes at least one grace period (15 seconds in the cluster, 3 in Compose); a crash at any point only repeats a pass.
- The registry keeps the tenant row, its handle (never reused), and its audit trail, so the deletion stays explainable afterwards.
- Exporting a shop's data before deletion is not built yet; the blueprint lists it for later.
