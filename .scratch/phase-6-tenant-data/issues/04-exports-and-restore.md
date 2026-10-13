# 04: Scheduled per-tenant exports and restore

**What to build:** The platform worker exports every ACTIVE shop every 15 minutes to a volume, keeping 8; an operator restores a shop to one of them (decision 3: exports now, PITR deferred).

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] PVC `tenant-exports` in `platform-dev`, mounted by the platform worker only; Compose: a named volume
- [ ] Export loop: `/exports/<tenant>/<timestamp>.json` with rows and checksums; keeps 8 per shop; `platform_exports_total`, last export age per shop
- [ ] `GET /operator/tenants/:handle/exports`, `POST /operator/tenants/:handle/restore {export}`; `make tenant-exports`, `make tenant-restore HANDLE=… EXPORT=…`
- [ ] Restore workflow: freeze (`RESTORING`), drain Pending, purge in the cell, import, verify against the export's checksums, unfreeze; resumable
- [ ] Tests (Compose): products deleted after an export come back with a restore; changes after the export are gone (as stated); another shop's rows unchanged
