# 02: A synthetic shop in every cell

**What to build:** Every registered cell holds one internal synthetic shop with a product to buy, created by the control plane when the cell registers, so the promoter can check out in any cell. Internal shops do not count against a cell's capacity: a dedicated cell with its synthetic shop still takes one plus shop.

**Blocked by:** none

**Status:** in review

- [ ] Registration ensures the cell's synthetic shop: handle `synthetic-<cell>` (the canary keeps its seeded `canary`), internal, placed in that cell, provisioned through the outbox; at most one internal shop per cell (unique index)
- [ ] `place()` and the registration capacity check count only non-internal shops; the fleet view's `placed` likewise, with the synthetic shop shown apart
- [ ] The handle prefix `synthetic-` is reserved at signup
- [ ] The cell's catalog API: `POST /internal/tenants/:id/synthetic-catalog` (the cell's platform token) ensures one product (`Synthetic Probe`, large Stock); provisioning calls it for internal shops before the check
- [ ] Seam-1 tests: a registered test cell gets its synthetic shop, ACTIVE, with its product; a dedicated cell holding its synthetic shop takes one plus signup and refuses the next; the endpoint refuses another cell's token
- [ ] Cluster: `make fleet` shows each cell's synthetic shop; a decline Checkout in each completes

## Comments

Implementation notes (2026-10-13):
- A cell's registration (`register`, in its transaction, under the cell's row lock) gives it a synthetic shop unless it holds one: `synthetic-<cell>`, internal, placed in that cell, with its created and placed events (actor `registration`) and a provision request. A unique index allows one non-deleted internal shop per cell. Its password hash is `unusable`, which no password matches. A deleted synthetic shop keeps its handle, so that cell then goes without one.
- Provisioning an internal shop first asks the cell's catalog API to fill its catalog (`POST /internal/tenants/:id/synthetic-catalog`, the cell's platform token, like a purge): one product, `Synthetic Probe`, 1,000,000 in Stock, created once (an advisory lock per shop). A failure is recorded (`catalog_failed`) and retried. The promoter will buy it with the decline scenario, which leaves Stock unchanged.
- Capacity counts only shops that are not internal: placement, the registration's capacity check, and the fleet view's `placed` and counts. The fleet view shows each cell's synthetic shop in its own field; `make fleet` adds a SYNTHETIC column.
- Cell ids are now at most 20 characters (`cellIdPattern` and a check on `platform.cells`), so `synthetic-<cell>` fits a handle. Handles starting `synthetic-` are reserved at signup.
- The Phase 3 seed path for the canary's shop is retired: `canary-shop.sql`, `SEED_CANARY_SHOP`, `db/seed/canary.sql`, and the canary cell's seed job. Otherwise a fresh cluster would get two internal shops for the canary cell. On the lab cluster, `canary` is already placed in the canary cell, so its registration finds it and creates nothing.
- The Phase 3 test of an unplaced internal shop waiting for a canary cell is replaced: internal shops are now always placed when created.

Rollout: no new secret. At the merge commit, the old images run without the seed settings, which they treat as off. After the digest commit, the platform migration runs and each cell registers again on its sync. If a cell's registration reached the old control plane first, its synthetic shop appears on that cell's next sync. Provisioning retries until the cell's new catalog API answers.

`make test CELLS=2` with the k3d cluster stopped: 32 files passed. In `cells.test.ts` two tests failed, both test mistakes: a check that ran before the shop's check step was recorded, and, as a result, a later plus signup that took that test's free dedicated cell. After the fixes `cells.test.ts` and `containment.test.ts` pass (17 tests). Locally `synthetic-pool-1` and `synthetic-dedicated-1` are ACTIVE, and a decline Checkout in each ends Rejected.
