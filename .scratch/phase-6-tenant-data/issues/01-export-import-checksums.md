# 01: Export, import, and checksum one tenant in a cell

**What to build:** Narrow per-cell functions that read out one tenant's rows, write them into another cell keeping ids, and fingerprint each table, behind internal endpoints the control plane calls with the cell's own token.

**Blocked by:** none

**Status:** in review

- [x] Migrations (expand-only) in `catalog` and `orders`: `export_tenant(uuid) → jsonb`, `import_tenant(uuid, jsonb)`, `tenant_checksums(uuid) → (table, rows, md5)` over the eight tenant-owned tables
- [x] Catalog API and order service: `POST /internal/tenants/:id/export`, `POST /internal/tenants/:id/import`, `GET /internal/tenants/:id/checksums` (cell token)
- [x] Tests: export → import into dedicated-1 (Compose, two cells) gives equal checksums; checksums ignore row order; another tenant's token or rows are untouched; import refuses a tenant that already has rows

## Comments

Implementation notes (2026-10-14):
- Migrations `20261014000008` (catalog) and `20261014000108` (orders), expand only: three SECURITY DEFINER functions per schema, granted to that schema's app identity alone, each scoped to one tenant id (ADR-0012's pattern, like the purges).
  - `export_tenant(t)` returns one JSON array per table, keyed `schema.table`, its rows in primary-key order, timestamps rendered in UTC.
  - `tenant_checksums(t)` returns `{table: {rows, md5}}`, md5 over that export: one jsonb value instead of the ticket's `(table, rows, md5)` rows, so an endpoint returns it as is. Key order makes it independent of the order rows were inserted in.
  - `import_tenant(t, rows)` refuses a tenant with rows in the cell already (`unique_violation`) and any row of another tenant (`check_violation`), inserts in dependency order keeping ids, and returns the checksums. Orders enter `PENDING`, as the status trigger requires, and step through allowed transitions to their status, so the trigger stays in force for imports.
- Endpoints in the catalog API and the order service, with the cell token (`x-platform-token`), like a purge: `POST /internal/tenants/:id/export` (rows and checksums from one statement, so one snapshot), `POST /internal/tenants/:id/import` (`{rows}`, up to 32 MB; 409 `tenant_not_empty`, 422 `rows_refused`), `GET /internal/tenants/:id/checksums`.
- Compose publishes dedicated-1's APIs on loopback (4021, 4022) for the tests, like the control plane's internal listener.

Tests (`tenant-data.test.ts`, two cells): Harbor's rows (with a fresh CONFIRMED and REJECTED_PAYMENT Order, after its Pending Orders settle) exported from pool-1 and imported into dedicated-1 with every table's array reversed give the source's checksums, in the import's answer and on a fresh read; Meadow's checksums in both cells are unchanged. A second import answers 409, rows under Meadow's id 422, and neither writes anything. No token or pool-1's token answers 401 in dedicated-1. A purge of the copy leaves pool-1's original unchanged. In the run, Harbor's 2,716 Orders in all four end statuses moved in about a second.

`make test CELLS=2` with the cluster stopped: 43 files, 225 tests passed (326 s).
