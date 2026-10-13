# 03: Move a tenant between cells

**What to build:** The move workflow in the control plane, an operator endpoint, and `make tenant-move HANDLE=… CELL=…`.

**Blocked by:** 01, 02 (both deployed to every wave)

**Status:** ready-for-agent

- [ ] `POST /operator/tenants/:handle/move {cell}`: refuses an unregistered or full target, a shop not ACTIVE, an internal shop; a dedicated target makes the plan `plus`
- [ ] Outbox action `move`: freeze, drain Pending (60 s), export, import, verify counts and checksums, switch cell and plan and unfreeze in one transaction, purge and verify the source; every step an event with its counts; resumable
- [ ] Undo before the switch: purge the target, unfreeze in the source
- [ ] Tests (Compose, two cells): a starter shop with products, Carts, and Pending Orders moves pool-1 → dedicated-1 (counts and checksums equal, Pending Orders settle in dedicated-1, nothing left in pool-1, served from dedicated-1); a move whose import fails ends ACTIVE in pool-1 with nothing in dedicated-1; a worker restart mid-move resumes
