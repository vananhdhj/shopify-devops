import type { Pool } from "pg";
import { withTransaction } from "@shop/service-kit";
import type { CellCredentials } from "@shop/tenancy";
import { endpointsOf } from "./cells.ts";
import { type LifecycleEvent, complete, recordEvent } from "./lifecycle.ts";

/** Rows a purge removed and rows of the shop left afterwards, per table. */
export interface PurgeReport {
  deleted: Record<string, number>;
  remaining: Record<string, number>;
}

async function purge(baseUrl: string, cellToken: string, tenantId: string): Promise<PurgeReport> {
  const res = await fetch(`${baseUrl}/internal/tenants/${tenantId}/purge`, {
    method: "POST",
    headers: { "x-platform-token": cellToken },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`purge at ${baseUrl} answered ${res.status}`);
  return (await res.json()) as PurgeReport;
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, n) => sum + n, 0);

export type DeletionOutcome = "deleted" | "verify_later" | "nothing_to_do";

/**
 * Deletes one shop from the cell that holds it, in two passes, through that cell's APIs and with
 * that cell's own token (a cell's token opens no other cell). Routing already stopped when the operator asked
 * (DELETING). Each pass purges the shop's Orders first, so no settle job can load one afterwards,
 * then its catalog. A job that had loaded an Order just before the first pass may still write an
 * Inventory effect for a few seconds, so the first pass is followed, after `graceMs`, by a
 * second; the shop is DELETED only when a pass finds nothing left to delete and nothing remains
 * in any of the eight tenant-owned tables. Every pass is recorded with its counts. Purging is
 * idempotent, so a crash at any point only repeats a pass. A cell that cannot be reached, or
 * whose token the control plane lacks, fails the attempt, which is retried.
 */
export async function deleteShop(
  db: Pool,
  credentials: CellCredentials,
  event: LifecycleEvent,
  graceMs: number,
): Promise<DeletionOutcome> {
  const { rows } = await db.query<{ status: string; cell: string | null }>(
    "SELECT status, cell FROM platform.tenants WHERE id = $1",
    [event.tenantId],
  );
  const tenant = rows[0];
  if (tenant?.status !== "DELETING") {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }

  // Only an active or suspended shop can be deleted, and neither exists without a cell.
  const cell = tenant.cell === null ? undefined : await endpointsOf(db, tenant.cell);
  if (!cell) throw new Error(`cell ${tenant.cell} of the shop is not registered`);
  const cellToken = credentials.get(cell.id, "platform-cell-token");
  if (!cellToken) throw new Error(`no platform-cell-token for cell ${cell.id}`);

  const orders = await purge(cell.ordersUrl, cellToken, event.tenantId);
  const catalog = await purge(cell.catalogUrl, cellToken, event.tenantId);
  const deleted = { ...orders.deleted, ...catalog.deleted };
  const remaining = { ...orders.remaining, ...catalog.remaining };

  const passes = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM platform.tenant_events WHERE tenant_id = $1 AND step = 'purged'",
    [event.tenantId],
  );
  const clean = total(deleted) === 0 && total(remaining) === 0;
  if (passes.rows[0]!.n === 0 || !clean) {
    await withTransaction(db, async (client) => {
      await recordEvent(client, event.tenantId, "purged", { deleted, remaining });
      await client.query(
        "UPDATE platform.lifecycle_outbox SET not_before = now() + make_interval(secs => $2) WHERE event_id = $1",
        [event.eventId, graceMs / 1000],
      );
    });
    return "verify_later";
  }

  await withTransaction(db, async (client) => {
    await client.query("UPDATE platform.tenants SET status = 'DELETED' WHERE id = $1 AND status = 'DELETING'", [event.tenantId]);
    await recordEvent(client, event.tenantId, "deleted", { verified: remaining }, { from: "DELETING", to: "DELETED" });
    await complete(client, event.eventId);
  });
  return "deleted";
}
