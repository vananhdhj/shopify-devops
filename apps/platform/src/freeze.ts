import type { Pool } from "pg";
import type { Queryable } from "@shop/service-kit";
import type { CellCredentials } from "@shop/tenancy";
import { CellData, type Checksums, type TenantRows } from "./cell-data.ts";
import { endpointsOf } from "./cells.ts";
import { type LifecycleEvent, recordEvent } from "./lifecycle.ts";

/** How a frozen shop (a move's or a restore's, Phase 6) is made quiet before its rows are read. */
export interface FreezeConfig {
  /** From the freeze to the first read: longer than an edge's routing refresh plus a write in flight. */
  freezeGraceMs: number;
  /** How long the shop's Pending Orders may take to settle before the workflow is undone. */
  drainTimeoutMs: number;
  /** Between two looks at the Pending Orders while draining. */
  drainPollMs: number;
}

/** Puts a lifecycle event back, due again in `ms` (a step waiting, not a failure). */
export async function later(db: Queryable, event: LifecycleEvent, ms: number): Promise<void> {
  await db.query("UPDATE platform.lifecycle_outbox SET not_before = now() + make_interval(secs => $2) WHERE event_id = $1", [
    event.eventId,
    Math.max(ms, 0) / 1000,
  ]);
}

/** A registered cell's tenant-data endpoints, with the cell's own token. */
export async function cellDataFor(db: Queryable, credentials: CellCredentials, id: string): Promise<CellData> {
  const cell = await endpointsOf(db, id);
  if (!cell) throw new Error(`cell ${id} is not registered`);
  const token = credentials.get(id, "platform-cell-token");
  if (!token) throw new Error(`no platform-cell-token for cell ${id}`);
  return new CellData(cell, token);
}

const pendingIn = (rows: TenantRows) => (rows["orders.orders"] ?? []).filter((order) => order.status === "PENDING").length;

/**
 * Waits out the freeze grace, then until the frozen shop has no Pending Order in its cell: each
 * settles where it was placed, so none is paid twice. Returns "later" (the event is put back)
 * while waiting, and the shop's Orders export once quiet; throws once the drain times out.
 */
export async function drained(
  db: Pool,
  event: LifecycleEvent,
  frozenAt: Date,
  config: FreezeConfig,
  cell: CellData,
  tenantId: string,
  step: string,
): Promise<"later" | { rows: TenantRows; checksums: Checksums }> {
  const frozenMs = Date.now() - frozenAt.getTime();
  if (frozenMs < config.freezeGraceMs) {
    await later(db, event, config.freezeGraceMs - frozenMs);
    return "later";
  }
  const orders = await cell.export("orders", tenantId);
  const pending = pendingIn(orders.rows);
  if (pending > 0) {
    if (frozenMs < config.freezeGraceMs + config.drainTimeoutMs) {
      await later(db, event, config.drainPollMs);
      return "later";
    }
    throw new Error(`${pending} Pending Orders did not settle within ${config.drainTimeoutMs / 1000} s`);
  }
  await recordEvent(db, tenantId, step, { frozenMs });
  return orders;
}
