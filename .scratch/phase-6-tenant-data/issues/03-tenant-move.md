# 03: Move a tenant between cells

**What to build:** The move workflow in the control plane, an operator endpoint, and `make tenant-move HANDLE=… CELL=…`.

**Blocked by:** 01, 02 (both deployed to every wave)

**Status:** in review

- [x] `POST /operator/tenants/:handle/move {cell}`: refuses an unregistered or full target, a shop not ACTIVE, an internal shop; a dedicated target makes the plan `plus`
- [x] Outbox action `move`: freeze, drain Pending (60 s), export, import, verify counts and checksums, switch cell and plan and unfreeze in one transaction, purge and verify the source; every step an event with its counts; resumable
- [x] Undo before the switch: purge the target, unfreeze in the source
- [x] Tests (Compose, two cells): a starter shop with products, Carts, and Pending Orders moves pool-1 → dedicated-1 (counts and checksums equal, Pending Orders settle in dedicated-1, nothing left in pool-1, served from dedicated-1); a move whose import fails ends ACTIVE in pool-1 with nothing in dedicated-1; a worker restart mid-move resumes

## Comments

Implementation notes (2026-10-14):
- Migration `20261014000206` (platform, expand only): outbox action `move`; `platform.tenant_moves`, one row per move (source, target, plan after, the last step finished, the verified checksums, why it was undone, when the shop was frozen and unfrozen); at most one open move per shop; the app identity may now update a shop's `plan`.
- `POST /operator/tenants/:handle/move {cell}` (`requestMove`): in one transaction, the checks, `ACTIVE → MOVING`, the move's row, the outbox event, and the audit event. 202, or 404 `tenant_not_found`, or 409 with `internal_shop`, `not_active`, `same_cell`, `unknown_cell`, `canary_cell`, `plan_downgrade` (a plus shop moves only into a dedicated cell), or `no_capacity`. A move's target counts as taken from the request (`shopsIn`, shared with placement), so a signup cannot fill it meanwhile.
- The worker (`moveShop`, `apps/platform/src/move.ts`), resuming from the row's step:
  - `frozen`: wait out the freeze grace (`MOVE_FREEZE_GRACE_MS`, 5 s: an edge's routing refresh is 2 s, plus a write in flight); wait for the shop's Pending Orders to settle in the source (`MOVE_DRAIN_TIMEOUT_MS`, 60 s, polled every 0.5 s); export both APIs; purge any copy an earlier attempt left in the target; import; check every table's count and md5 in the target against the export, and the source's against the export again (nothing written meanwhile) → `verified`, with the checksums;
  - `verified`: the shop's cell, plan, and `ACTIVE`, in one transaction → `switched`;
  - `switched`: after the grace again (every edge routes to the target before the source empties), purge the source and require nothing left → `done`.
- Anything failing before the switch undoes the move: the shop is unfrozen in the source first (`undoing`, `move_failed`), then its copy is purged from the target, retried with backoff until that cell answers (`undone`). After the switch, failures are retried like a deletion's. Every step is an event: `move`, `move_drained`, `move_verified` (checksums), `move_switched` (from, to, plan, `frozenMs`), `move_source_purged` (counts), or `move_failed` and `move_undone`.
- **Pending Orders settle in the source, during the drain, not in the target** (a deviation from the spec's experiment wording). An Order exported Pending would also be settled by the source's worker, which holds its job: its payment would run twice. A move whose Orders do not settle within 60 s is undone.
- `make tenant-move HANDLE=… CELL=…` (`scripts/tenant.sh move`): requests the move, follows its events to the end, and prints each step, the checksums, and the time frozen; it fails, naming the reason, when the move is refused or undone.
- Deletion now purges through the same cell client (`cell-data.ts`).
- Known gaps, for ticket 05's evidence:
  - Order links: an Order token is signed with the cell's own secret, so a buyer's link to an Order placed before the move no longer opens after it.
  - Merchant sessions: these are signed per cell too, so the Merchant signs in again after a move.

Tests (`move.test.ts`, Compose, two cells, fresh starter shops):
- A move with dedicated-1's catalog API stopped is undone. The shop is ACTIVE in pool-1 again within seconds and takes Cart adds. Once the API is back, its copy is purged from dedicated-1 (empty checksums), and pool-1's rows are as before.
- A shop with two products, a Cart, two settled Orders, and one Pending (slow payment) moves to dedicated-1. A second request while it moves answers 409. The platform worker is killed after the switch and restarted, and the move resumes to the source's purge. Then:
  - dedicated-1's checksums equal the verified ones, and pool-1 holds nothing of the shop;
  - its three Orders are there once each, the Pending one CONFIRMED;
  - it is ACTIVE and plus in dedicated-1, frozen under 30 s;
  - the buyer's Cart survived, and a new Order settles in dedicated-1.
- Refusals: an unknown shop or cell, the same cell, a full cell, a synthetic shop, and a plus shop into a pooled cell.

In the last run, the move was frozen 5.2 s, of which 5 s was the grace; drain, export, import, and verify took 40 ms; the source was purged 5.2 s after the switch, after the worker's restart. `make test CELLS=2` with the cluster stopped: 45 files, 237 tests passed (357 s).
