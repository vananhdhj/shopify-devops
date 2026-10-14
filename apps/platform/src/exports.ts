import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { type Queryable, withTransaction } from "@shop/service-kit";
import type { CellCredentials } from "@shop/tenancy";
import type { CellData, Checksums, TenantRows } from "./cell-data.ts";
import { endpointsOf } from "./cells.ts";
import { cellDataFor } from "./freeze.ts";
import { type LifecycleEvent, complete } from "./lifecycle.ts";

/** One export as written to the volume: the shop's rows and their checksums at that moment. */
export interface ExportFile {
  tenantId: string;
  handle: string;
  cell: string;
  kind: ExportKind;
  takenAt: string;
  checksums: Checksums;
  rows: TenantRows;
}
export type ExportKind = "scheduled" | "on-demand" | "pre-restore";

/**
 * The platform worker's export directory (a volume only it mounts: exports hold customer data).
 * Files are written to a temporary name and renamed, so a reader never sees half an export.
 */
export class ExportStore {
  constructor(readonly dir: string) {}

  async write(file: string, content: ExportFile): Promise<number> {
    const path = join(this.dir, file);
    await mkdir(dirname(path), { recursive: true });
    const body = JSON.stringify(content);
    await writeFile(`${path}.partial`, body, { mode: 0o600 });
    await rename(`${path}.partial`, path);
    return Buffer.byteLength(body);
  }

  async read(file: string): Promise<ExportFile> {
    return JSON.parse(await readFile(join(this.dir, file), "utf8")) as ExportFile;
  }

  async remove(file: string): Promise<void> {
    await rm(join(this.dir, file), { force: true });
  }

  /** Everything of one shop, its directory included. */
  async removeTenant(tenantId: string): Promise<void> {
    await rm(join(this.dir, tenantId), { recursive: true, force: true });
  }
}

/** Reads one shop out of its cell, both APIs, and writes it to the store; returns its record's id. */
export async function takeExport(
  db: Queryable,
  store: ExportStore,
  cell: CellData,
  tenant: { id: string; handle: string },
  kind: ExportKind,
  orders?: { rows: TenantRows; checksums: Checksums },
): Promise<{ id: string; checksums: Checksums; file: string }> {
  const catalog = await cell.export("catalog", tenant.id);
  const ordersExport = orders ?? (await cell.export("orders", tenant.id));
  const takenAt = new Date();
  const checksums = { ...catalog.checksums, ...ordersExport.checksums };
  const file = `${tenant.id}/${takenAt.toISOString().replace(/[:.]/g, "-")}-${kind}.json`;
  const bytes = await store.write(file, {
    tenantId: tenant.id,
    handle: tenant.handle,
    cell: cell.cell.id,
    kind,
    takenAt: takenAt.toISOString(),
    checksums,
    rows: { ...catalog.rows, ...ordersExport.rows },
  });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO platform.tenant_exports (tenant_id, kind, cell, file, bytes, checksums, taken_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tenant.id, kind, cell.cell.id, file, bytes, checksums, takenAt],
  );
  return { id: rows[0]!.id, checksums, file };
}

/**
 * Deletes a shop's exports beyond the newest `keep`, files first, then their records; an export
 * an unfinished restore uses is kept. A file whose record is gone is never listed again.
 */
export async function prune(db: Queryable, store: ExportStore, tenantId: string, keep: number): Promise<number> {
  const { rows } = await db.query<{ id: string; file: string }>(
    `SELECT id, file FROM platform.tenant_exports e
      WHERE tenant_id = $1
        AND id NOT IN (SELECT id FROM platform.tenant_exports WHERE tenant_id = $1 ORDER BY taken_at DESC LIMIT $2)
        AND NOT EXISTS (SELECT 1 FROM platform.tenant_restores r
                         WHERE r.finished_at IS NULL AND e.id IN (r.export_id, r.saved_export_id))`,
    [tenantId, keep],
  );
  for (const row of rows) {
    await store.remove(row.file);
    await db.query("DELETE FROM platform.tenant_exports WHERE id = $1", [row.id]);
  }
  return rows.length;
}

export type ExportOutcome = "exported" | "nothing_to_do";

/**
 * One export event: the shop's rows from its cell, written to the volume and recorded, then the
 * shop's exports pruned to the newest `keep`. Only an ACTIVE shop is exported: a frozen one is
 * being moved or restored (the scheduler asks again later), and a suspended or deleted one serves
 * nobody. A failure is retried like any lifecycle step.
 */
export async function exportShop(
  db: Pool,
  credentials: CellCredentials,
  store: ExportStore,
  event: LifecycleEvent,
  keep: number,
): Promise<ExportOutcome> {
  const { rows } = await db.query<{ handle: string; status: string; cell: string | null }>(
    "SELECT handle, status, cell FROM platform.tenants WHERE id = $1",
    [event.tenantId],
  );
  const tenant = rows[0];
  if (tenant?.status !== "ACTIVE" || tenant.cell === null) {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }
  // A shop whose cell left the directory cannot be read; the scheduler skips it too.
  if (!(await endpointsOf(db, tenant.cell))) {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }
  const kind: ExportKind = event.priority > 0 ? "on-demand" : "scheduled";
  await takeExport(db, store, await cellDataFor(db, credentials, tenant.cell), { id: event.tenantId, handle: tenant.handle }, kind);
  await prune(db, store, event.tenantId, keep);
  await complete(db, event.eventId);
  return "exported";
}

/**
 * Asks for an export of every ACTIVE shop in a registered cell (synthetic shops aside) whose newest is older than
 * `intervalMs`, unless one is already asked for: one outbox event each, which the worker takes
 * like any lifecycle step. At most `batch` a call, the most overdue first, so a round is spread
 * over several calls rather than loading the cells at once. Returns how many were asked for.
 */
export async function scheduleExports(db: Queryable, intervalMs: number, batch: number): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO platform.lifecycle_outbox (tenant_id, action)
     SELECT t.id, 'export' FROM platform.tenants t
      WHERE t.status = 'ACTIVE' AND NOT t.internal
        AND EXISTS (SELECT 1 FROM platform.cells c WHERE c.id = t.cell AND c.registered_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM platform.lifecycle_outbox o
                         WHERE o.tenant_id = t.id AND o.action = 'export' AND o.completed_at IS NULL)
        AND coalesce((SELECT max(taken_at) FROM platform.tenant_exports e WHERE e.tenant_id = t.id), '-infinity')
            < now() - make_interval(secs => $1)
      ORDER BY (SELECT max(taken_at) FROM platform.tenant_exports e WHERE e.tenant_id = t.id) NULLS FIRST
      LIMIT $2`,
    [intervalMs / 1000, batch],
  );
  return rowCount ?? 0;
}

/** Deletes every export of a deleted shop: its data is gone from its cell, so from here too. */
export async function forgetDeleted(db: Queryable, store: ExportStore): Promise<number> {
  const { rows } = await db.query<{ tenant_id: string }>(
    `SELECT DISTINCT e.tenant_id FROM platform.tenant_exports e JOIN platform.tenants t ON t.id = e.tenant_id
      WHERE t.status = 'DELETED'`,
  );
  for (const row of rows) {
    await store.removeTenant(row.tenant_id);
    await db.query("DELETE FROM platform.tenant_exports WHERE tenant_id = $1", [row.tenant_id]);
  }
  return rows.length;
}

export interface ExportSummary {
  id: string;
  kind: ExportKind;
  cell: string;
  takenAt: string;
  bytes: number;
  rows: Record<string, number>;
}

/** A shop's exports, newest first, with each table's row count (what an operator picks a restore point by). */
export async function listExports(db: Queryable, handle: string): Promise<ExportSummary[] | undefined> {
  const tenant = await db.query("SELECT 1 FROM platform.tenants WHERE handle = $1", [handle]);
  if (tenant.rowCount === 0) return undefined;
  const { rows } = await db.query<{ id: string; kind: ExportKind; cell: string; taken_at: Date; bytes: string; checksums: Checksums }>(
    `SELECT e.id, e.kind, e.cell, e.taken_at, e.bytes, e.checksums
       FROM platform.tenant_exports e JOIN platform.tenants t ON t.id = e.tenant_id
      WHERE t.handle = $1 ORDER BY e.taken_at DESC`,
    [handle],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    cell: row.cell,
    takenAt: row.taken_at.toISOString(),
    bytes: Number(row.bytes),
    rows: Object.fromEntries(Object.entries(row.checksums).map(([table, sum]) => [table, sum.rows])),
  }));
}

export type ExportRequest = { outcome: "requested" } | { outcome: "not_found" } | { outcome: "not_active"; status: string };

/** The operator asks for an export of one shop now (for instance before a risky change). */
export async function requestExport(db: Pool, handle: string): Promise<ExportRequest> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string; status: string; internal: boolean }>(
      "SELECT id, status, internal FROM platform.tenants WHERE handle = $1 FOR UPDATE",
      [handle],
    );
    const tenant = rows[0];
    if (!tenant) return { outcome: "not_found" };
    if (tenant.status !== "ACTIVE" || tenant.internal) return { outcome: "not_active", status: tenant.internal ? "internal" : tenant.status };
    const event = await client.query<{ event_id: string }>(
      "INSERT INTO platform.lifecycle_outbox (tenant_id, action, priority) VALUES ($1, 'export', 1) RETURNING event_id",
      [tenant.id],
    );
    await client.query(
      "INSERT INTO platform.tenant_events (tenant_id, step, actor, detail) VALUES ($1, 'export', 'operator', $2)",
      [tenant.id, { exportEvent: event.rows[0]!.event_id }],
    );
    return { outcome: "requested" };
  });
}
