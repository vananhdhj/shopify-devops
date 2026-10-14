# 04: Scheduled per-tenant exports and restore

**What to build:** The platform worker exports every ACTIVE shop every 15 minutes to a volume, keeping 8; an operator restores a shop to one of them (decision 3: exports now, PITR deferred).

**Blocked by:** 01, 02

**Status:** in review

- [x] PVC `tenant-exports` in `platform-dev`, mounted by the platform worker only; Compose: a named volume
- [x] Export loop: `/exports/<tenant>/<timestamp>.json` with rows and checksums; keeps 8 per shop; `platform_exports_total`, last export age per shop
- [x] `GET /operator/tenants/:handle/exports`, `POST /operator/tenants/:handle/restore {export}`; `make tenant-exports`, `make tenant-restore HANDLE=… EXPORT=…`
- [x] Restore workflow: freeze (`RESTORING`), drain Pending, purge in the cell, import, verify against the export's checksums, unfreeze; resumable
- [x] Tests (Compose): products deleted after an export come back with a restore; changes after the export are gone (as stated); another shop's rows unchanged

## Comments

Implementation notes (2026-10-14):
- Migration `20261014000207` (platform, expand only):
  - outbox actions `export` and `restore`;
  - `platform.tenant_exports`: one record per file on the volume (kind, cell, file, bytes, each table's rows and md5), so the API lists exports without mounting the volume;
  - `platform.tenant_restores`: resumable like a move.
- Exports run as lifecycle events with their own worker loop, one at a time. They never hold up a signup, a deletion, a move, or a restore: in the first version they shared the loop, and a round of every Compose shop's export held a move up past its test's timeout.
  - The scheduler (every `EXPORT_SCHEDULE_MS`, 60 s; 2 s in Compose) asks for an export of every ACTIVE shop in a registered cell whose newest export is older than `EXPORT_INTERVAL_MS` (15 min). Synthetic shops are not exported.
  - It asks for at most `EXPORT_BATCH` (20) a tick, most overdue first, so a round is spread out rather than loading the cells at once. An operator's export has priority 1 (a new outbox column) and goes before a round.
  - Compose exports daily, not every 15 minutes. The suites leave hundreds of shops (395 in this stack), and a round of them under the tests slowed the cell enough to fail a timing test (a slow payment confirmed under 3 s after its Checkout answered) and queued the on-demand exports behind it. A new shop is still exported at once.
  - Files are `/exports/<tenant>/<time>-<kind>.json` (rows and checksums, mode 600), written under a temporary name and renamed.
  - The 8 newest are kept per shop, except an export an open restore uses.
  - A deleted shop's exports are removed, files and records.
  - An export of a shop whose cell left the directory completes without exporting (test cells).
- `platform_exports_total` and `platform_export_age_seconds{tenant_id}` (since the shop's creation when it has none).
- Volume: in the cluster, PVC `tenant-exports` (1 Gi, local-path) mounted only by the platform worker, with `fsGroup`. In Compose, the named volume `tenantexports`. The image creates `/exports` owned by `node`. Without `EXPORTS_DIR` the worker logs it and exports nothing, so the manifests and the image work in either order.
- Operator endpoints:
  - `GET /operator/tenants/:handle/exports`: newest first, with row counts;
  - `POST /operator/tenants/:handle/exports`: one now, `on-demand`;
  - `POST /operator/tenants/:handle/restore {export}`: 202 with "everything the shop changed since <time> is lost"; 404 for an unknown shop or an export not the shop's; 409 for a shop not ACTIVE or a synthetic one.
- Make targets: `make tenant-exports HANDLE=…`, `make tenant-export HANDLE=…`, `make tenant-restore HANDLE=… EXPORT=…`. The restore one follows the restore to its end.
- Restore (`apps/platform/src/restore.ts`), resuming from its row's step:
  1. `frozen` (`RESTORING`): the freeze grace and the drain, shared with the move (`freeze.ts`); then the shop as it is now is saved as a `pre-restore` export → `saved`.
  2. `saved`: purge the shop in its cell, import the chosen export, check every table's count and md5 against the export's, unfreeze → `done`.
  3. A failure while frozen unfreezes the shop unchanged. A failure once saved (an unreadable export, a cell error, a mismatch) puts the pre-restore export back the same way, then unfreezes (`undoing` → `undone`), retried until the cell answers.
- Limits, for the evidence:
  - a restore loses everything since its export, Orders included;
  - an export reads the catalog and the Orders in two statements, so they are not one snapshot;
  - an export from before a later migration adds a column would import that column as NULL;
  - the shop's rows are absent for the moment between the purge and the import (it is frozen, so only browsing sees it);
  - the Merchant admin has no product deletion yet: the tests delete products directly, and ticket 05's experiment needs a Merchant action.

Tests (`restore.test.ts`, Compose):
- A new shop gets a scheduled export of all eight tables, on the worker's volume.
- Restore after an on-demand export (3 products, 1 Order), then a new Order, then two products deleted. The restore's steps are `restore`, `restore_drained`, `restore_saved`, `restored`, frozen under 30 s. Then:
  - the three products are back, and every table's checksum is the export's;
  - the Order placed after the export is gone;
  - Meadow's checksums are unchanged;
  - the storefront shows the restored product;
  - a pre-restore export holds the state before (1 product, 2 Orders).
- With the chosen export's file removed, the restore ends `restore_failed`, `restore_undone`, and the shop's checksums are as before.
- Refused: an unknown export, another shop's export, an unknown shop, a synthetic shop, and an id that is not one.
- A deleted shop's export records and directory are removed.
- `move.test.ts`: the "full cell" refusal runs only once dedicated-1 holds the moved shop. In a run where the move had failed, that case moved Meadow to dedicated-1; it was put back with the cell endpoints (export, import, equal checksums, registry, purge).

In the runs, a restore froze its shop 5.0 to 5.3 s, of which 5 s is the grace. A round of the Compose stack's 395 shops took 106 s.

`make test CELLS=2` with the cluster stopped: 46 files, 242 tests passed (382 s). Earlier runs failed on test-timing problems found and fixed above, and one signup test timed out with the host's load at 9.9; run alone it passed.
