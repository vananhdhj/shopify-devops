import type { Pool } from "pg";
import { withTransaction } from "@shop/service-kit";
import type { CellCredentials } from "@shop/tenancy";
import { type CellData, type Checksums, differences, type TenantRows, total } from "./cell-data.ts";
import type { ExportStore } from "./exports.ts";
import { takeExport } from "./exports.ts";
import { cellDataFor, drained, type FreezeConfig } from "./freeze.ts";
import { type LifecycleEvent, complete, recordEvent } from "./lifecycle.ts";

export type RestoreRequest =
  | { outcome: "requested"; tenantId: string; takenAt: string }
  | { outcome: "not_found"; what: "shop" | "export" }
  | { outcome: "refused"; message: string };

/**
 * The operator asks for a shop to be restored to one of its exports (Phase 6, decision 3). In one
 * transaction: the checks, the freeze (RESTORING, served read-only), the restore's record, the
 * worker's outbox event, and the audit event. Everything the shop changed since the export is
 * lost by the restore: the export is only as recent as the export interval.
 */
export async function requestRestore(db: Pool, handle: string, exportId: string): Promise<RestoreRequest> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string; status: string; cell: string | null; internal: boolean }>(
      "SELECT id, status, cell, internal FROM platform.tenants WHERE handle = $1 FOR UPDATE",
      [handle],
    );
    const tenant = rows[0];
    if (!tenant) return { outcome: "not_found", what: "shop" };
    if (tenant.internal) return { outcome: "refused", message: "a cell's synthetic shop is not restored" };
    if (tenant.status !== "ACTIVE" || tenant.cell === null) return { outcome: "refused", message: `cannot restore a shop that is ${tenant.status}` };
    const exported = await client.query<{ taken_at: Date }>("SELECT taken_at FROM platform.tenant_exports WHERE id = $1 AND tenant_id = $2", [
      exportId,
      tenant.id,
    ]);
    if (exported.rowCount === 0) return { outcome: "not_found", what: "export" };

    await client.query("UPDATE platform.tenants SET status = 'RESTORING' WHERE id = $1", [tenant.id]);
    const event = await client.query<{ event_id: string }>(
      "INSERT INTO platform.lifecycle_outbox (tenant_id, action) VALUES ($1, 'restore') RETURNING event_id",
      [tenant.id],
    );
    await client.query("INSERT INTO platform.tenant_restores (event_id, tenant_id, export_id, cell) VALUES ($1, $2, $3, $4)", [
      event.rows[0]!.event_id,
      tenant.id,
      exportId,
      tenant.cell,
    ]);
    const takenAt = exported.rows[0]!.taken_at.toISOString();
    await client.query(
      `INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
       VALUES ($1, 'ACTIVE', 'RESTORING', 'restore', 'operator', $2)`,
      [tenant.id, { export: exportId, takenAt }],
    );
    return { outcome: "requested", tenantId: tenant.id, takenAt };
  });
}

export type RestoreOutcome = "later" | "restored" | "undone" | "nothing_to_do";

interface RestoreRow {
  tenant_id: string;
  handle: string;
  cell: string;
  step: "frozen" | "saved" | "done" | "undoing" | "undone";
  export_file: string | null;
  saved_file: string | null;
  frozen_at: Date;
}

/**
 * One attempt at a restore, resuming from the last step its record holds:
 *   frozen:  wait out the freeze grace and for the shop's Pending Orders to settle; export the shop
 *            as it is now (a pre-restore export, kept with the others) -> saved;
 *   saved:   purge the shop in its cell, import the chosen export, check every table's count and
 *            checksum against the export's, and unfreeze -> done.
 * A failure while frozen unfreezes the shop as it was (undone). A failure once saved puts the
 * pre-restore export back the same way and then unfreezes (undoing -> undone), retried until the
 * cell answers. Only this shop's rows are touched: every call names its tenant id.
 */
export async function restoreShop(
  db: Pool,
  credentials: CellCredentials,
  store: ExportStore,
  event: LifecycleEvent,
  config: FreezeConfig,
): Promise<RestoreOutcome> {
  const { rows } = await db.query<RestoreRow>(
    `SELECT r.tenant_id, t.handle, r.cell, r.step, e.file AS export_file, s.file AS saved_file, r.frozen_at
       FROM platform.tenant_restores r
       JOIN platform.tenants t ON t.id = r.tenant_id
       LEFT JOIN platform.tenant_exports e ON e.id = r.export_id
       LEFT JOIN platform.tenant_exports s ON s.id = r.saved_export_id
      WHERE r.event_id = $1`,
    [event.eventId],
  );
  const restore = rows[0];
  if (!restore || restore.step === "done" || restore.step === "undone") {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }
  const cell = await cellDataFor(db, credentials, restore.cell);

  switch (restore.step) {
    case "frozen":
      try {
        const orders = await drained(db, event, restore.frozen_at, config, cell, restore.tenant_id, "restore_drained");
        if (orders === "later") return "later";
        const saved = await takeExport(db, store, cell, { id: restore.tenant_id, handle: restore.handle }, "pre-restore", orders);
        await withTransaction(db, async (client) => {
          await client.query("UPDATE platform.tenant_restores SET step = 'saved', saved_export_id = $2 WHERE event_id = $1", [
            event.eventId,
            saved.id,
          ]);
          await recordEvent(client, restore.tenant_id, "restore_saved", { export: saved.id, checksums: saved.checksums });
        });
        restore.saved_file = saved.file;
      } catch (err) {
        await finish(db, event, restore, "undone", "restore_failed", { reason: message(err) });
        return "undone";
      }
      return restoreSaved(db, event, restore, store, cell);
    case "saved":
      return restoreSaved(db, event, restore, store, cell);
    case "undoing":
      return putBack(db, event, restore, store, cell);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Replaces the shop's rows in its cell with an export's and checks them against its checksums. */
async function replaceRows(cell: CellData, tenantId: string, rows: TenantRows, expected: Checksums): Promise<Record<string, number>> {
  const { deleted, remaining } = await cell.purgeAll(tenantId);
  if (total(remaining) > 0) throw new Error(`rows of the shop remain after the purge: ${JSON.stringify(remaining)}`);
  const pick = (prefix: string) => Object.fromEntries(Object.entries(rows).filter(([table]) => table.startsWith(prefix)));
  const imported: Checksums = {
    ...(await cell.import("catalog", tenantId, pick("catalog."))),
    ...(await cell.import("orders", tenantId, pick("orders."))),
  };
  const mismatched = differences(expected, imported);
  if (mismatched.length > 0) throw new Error(`verification failed: ${mismatched.join(", ")} differ from the export`);
  return deleted;
}

async function restoreSaved(db: Pool, event: LifecycleEvent, restore: RestoreRow, store: ExportStore, cell: CellData): Promise<RestoreOutcome> {
  try {
    if (!restore.export_file) throw new Error("the export to restore is gone");
    const chosen = await store.read(restore.export_file);
    const deleted = await replaceRows(cell, restore.tenant_id, chosen.rows, chosen.checksums);
    await finish(db, event, restore, "done", "restored", { export: chosen.takenAt, replaced: deleted, checksums: chosen.checksums });
    return "restored";
  } catch (err) {
    await withTransaction(db, async (client) => {
      await client.query("UPDATE platform.tenant_restores SET step = 'undoing', reason = $2 WHERE event_id = $1", [event.eventId, message(err)]);
      await recordEvent(client, restore.tenant_id, "restore_failed", { reason: message(err), puttingBack: true });
    });
    return putBack(db, event, restore, store, cell);
  }
}

/** Puts the pre-restore export back, then unfreezes; a failure here is retried until the cell answers. */
async function putBack(db: Pool, event: LifecycleEvent, restore: RestoreRow, store: ExportStore, cell: CellData): Promise<RestoreOutcome> {
  if (!restore.saved_file) throw new Error("the pre-restore export is gone; the shop stays frozen for the operator");
  const saved = await store.read(restore.saved_file);
  await replaceRows(cell, restore.tenant_id, saved.rows, saved.checksums);
  await finish(db, event, restore, "undone", "restore_undone", { putBack: saved.takenAt });
  return "undone";
}

/** Unfreezes the shop and closes the restore and its outbox event, with the audit event. */
async function finish(
  db: Pool,
  event: LifecycleEvent,
  restore: RestoreRow,
  step: "done" | "undone",
  auditStep: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ frozen_ms: number }>(
      `UPDATE platform.tenant_restores SET step = $2, unfrozen_at = now(), finished_at = now() WHERE event_id = $1
       RETURNING (extract(epoch FROM unfrozen_at - frozen_at) * 1000)::int AS frozen_ms`,
      [event.eventId, step],
    );
    await client.query("UPDATE platform.tenants SET status = 'ACTIVE' WHERE id = $1 AND status = 'RESTORING'", [restore.tenant_id]);
    await recordEvent(client, restore.tenant_id, auditStep, { ...detail, frozenMs: rows[0]!.frozen_ms }, { from: "RESTORING", to: "ACTIVE" });
    await complete(client, event.eventId);
  });
}
