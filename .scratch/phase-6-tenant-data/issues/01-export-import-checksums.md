# 01: Export, import, and checksum one tenant in a cell

**What to build:** Narrow per-cell functions that read out one tenant's rows, write them into another cell keeping ids, and fingerprint each table, behind internal endpoints the control plane calls with the cell's own token.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Migrations (expand-only) in `catalog` and `orders`: `export_tenant(uuid) → jsonb`, `import_tenant(uuid, jsonb)`, `tenant_checksums(uuid) → (table, rows, md5)` over the eight tenant-owned tables
- [ ] Catalog API and order service: `POST /internal/tenants/:id/export`, `POST /internal/tenants/:id/import`, `GET /internal/tenants/:id/checksums` (cell token)
- [ ] Tests: export → import into dedicated-1 (Compose, two cells) gives equal checksums; checksums ignore row order; another tenant's token or rows are untouched; import refuses a tenant that already has rows
