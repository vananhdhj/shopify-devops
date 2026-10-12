# 02: A synthetic shop in every cell

**What to build:** Every registered cell holds one internal synthetic shop with a product to buy, created by the control plane when the cell registers, so the promoter can check out in any cell. Internal shops do not count against a cell's capacity: a dedicated cell with its synthetic shop still takes one plus shop.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Registration ensures the cell's synthetic shop: handle `synthetic-<cell>` (the canary keeps its seeded `canary`), internal, placed in that cell, provisioned through the outbox; at most one internal shop per cell (unique index)
- [ ] `place()` and the registration capacity check count only non-internal shops; the fleet view's `placed` likewise, with the synthetic shop shown apart
- [ ] The handle prefix `synthetic-` is reserved at signup
- [ ] The cell's catalog API: `POST /internal/tenants/:id/synthetic-catalog` (the cell's platform token) ensures one product (`Synthetic Probe`, large Stock); provisioning calls it for internal shops before the check
- [ ] Seam-1 tests: a registered test cell gets its synthetic shop, ACTIVE, with its product; a dedicated cell holding its synthetic shop takes one plus signup and refuses the next; the endpoint refuses another cell's token
- [ ] Cluster: `make fleet` shows each cell's synthetic shop; a decline Checkout in each completes
