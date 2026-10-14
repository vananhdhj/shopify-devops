import type { Pool } from "pg";
import { withTransaction } from "@shop/service-kit";
import type { CellCredentials } from "@shop/tenancy";
import { type CellData, type Checksums, differences, total } from "./cell-data.ts";
import { shopsIn } from "./cells.ts";
import { cellDataFor, drained, type FreezeConfig, later } from "./freeze.ts";
import { type LifecycleEvent, complete, recordEvent } from "./lifecycle.ts";

export type MoveRequest =
  | { outcome: "requested"; tenantId: string; from: string; to: string; planAfter: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: MoveRefusal; message: string };

export type MoveRefusal = "internal_shop" | "not_active" | "same_cell" | "unknown_cell" | "canary_cell" | "plan_downgrade" | "no_capacity";

/**
 * The operator asks for a shop to move to another cell (Phase 6). In one transaction: the checks,
 * the freeze (MOVING, which the edges serve read-only from their next routing refresh), the
 * move's record, the worker's outbox event, and the audit event. The target counts as taken from
 * here (`shopsIn`), so no signup can fill it meanwhile. A move into a dedicated cell makes the
 * shop plus; a plus shop never moves into a pooled cell (plan downgrades are out of scope).
 */
export async function requestMove(db: Pool, handle: string, target: string): Promise<MoveRequest> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string; status: string; cell: string | null; plan: string; internal: boolean }>(
      "SELECT id, status, cell, plan, internal FROM platform.tenants WHERE handle = $1 FOR UPDATE",
      [handle],
    );
    const tenant = rows[0];
    if (!tenant) return { outcome: "not_found" };
    const refuse = (reason: MoveRefusal, message: string): MoveRequest => ({ outcome: "refused", reason, message });
    if (tenant.internal) return refuse("internal_shop", "a cell's synthetic shop stays in its cell");
    if (tenant.status !== "ACTIVE" || tenant.cell === null) return refuse("not_active", `cannot move a shop that is ${tenant.status}`);
    if (tenant.cell === target) return refuse("same_cell", `${handle} is in ${target} already`);

    const cells = await client.query<{ role: string; capacity: number }>(
      "SELECT role, capacity FROM platform.cells WHERE id = $1 AND registered_at IS NOT NULL FOR UPDATE",
      [target],
    );
    const cell = cells.rows[0];
    if (!cell) return refuse("unknown_cell", `no registered cell ${target}`);
    if (cell.role === "canary") return refuse("canary_cell", "the canary cell holds only its synthetic shop");
    if (tenant.plan === "plus" && cell.role !== "dedicated") return refuse("plan_downgrade", "a plus shop moves only into a dedicated cell");
    if (((await shopsIn(client, [target])).get(target) ?? 0) >= cell.capacity) return refuse("no_capacity", `${target} is full`);

    const planAfter = cell.role === "dedicated" ? "plus" : tenant.plan;
    await client.query("UPDATE platform.tenants SET status = 'MOVING' WHERE id = $1", [tenant.id]);
    const event = await client.query<{ event_id: string }>(
      "INSERT INTO platform.lifecycle_outbox (tenant_id, action) VALUES ($1, 'move') RETURNING event_id",
      [tenant.id],
    );
    await client.query(
      "INSERT INTO platform.tenant_moves (event_id, tenant_id, source_cell, target_cell, plan_after) VALUES ($1, $2, $3, $4, $5)",
      [event.rows[0]!.event_id, tenant.id, tenant.cell, target, planAfter],
    );
    await client.query(
      `INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
       VALUES ($1, 'ACTIVE', 'MOVING', 'move', 'operator', $2)`,
      [tenant.id, { from: tenant.cell, to: target, planAfter }],
    );
    return { outcome: "requested", tenantId: tenant.id, from: tenant.cell, to: target, planAfter };
  });
}

/** A move freezes and drains the shop like a restore does. */
export type MoveConfig = FreezeConfig;

export type MoveOutcome = "later" | "moved" | "undone" | "nothing_to_do";

interface MoveRow {
  tenant_id: string;
  source_cell: string;
  target_cell: string;
  plan_after: string;
  step: "frozen" | "verified" | "switched" | "done" | "undoing" | "undone";
  frozen_at: Date;
  unfrozen_at: Date | null;
}

/**
 * One attempt at a move, resuming from the last step its record holds:
 *   frozen:   wait out the freeze grace; wait for the shop's Pending Orders to settle in the source
 *             (each settles where it was placed, so none is paid twice); export the shop from the
 *             source, clear any copy an earlier attempt left in the target, import, and verify every
 *             table's count and checksum in the target and, unchanged, in the source -> verified;
 *   verified: switch the shop's cell and plan and unfreeze, in one transaction -> switched;
 *   switched: once the edges route to the target (the freeze grace again), purge the source and
 *             verify nothing of the shop is left there -> done.
 * Anything failing before the switch undoes the move: the shop is unfrozen in the source at once
 * (undoing), then its copy is purged from the target, retried until it succeeds (undone). After
 * the switch a failure is retried, like a deletion. Every step is an event with its counts.
 */
export async function moveShop(db: Pool, credentials: CellCredentials, event: LifecycleEvent, config: MoveConfig): Promise<MoveOutcome> {
  const { rows } = await db.query<MoveRow>(
    "SELECT tenant_id, source_cell, target_cell, plan_after, step, frozen_at, unfrozen_at FROM platform.tenant_moves WHERE event_id = $1",
    [event.eventId],
  );
  const move = rows[0];
  if (!move || move.step === "done" || move.step === "undone") {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }
  const cellData = (id: string) => cellDataFor(db, credentials, id);

  switch (move.step) {
    case "frozen":
      try {
        const copied = await copy(db, event, move, config, await cellData(move.source_cell), await cellData(move.target_cell));
        if (copied === "later") return "later";
      } catch (err) {
        await beginUndo(db, event, move, err instanceof Error ? err.message : String(err));
        return finishUndo(db, event, move, await cellData(move.target_cell));
      }
      return switchOver(db, event, move, config);
    case "verified":
      return switchOver(db, event, move, config);
    case "switched":
      if (move.unfrozen_at && Date.now() - move.unfrozen_at.getTime() < config.freezeGraceMs) {
        await later(db, event, config.freezeGraceMs - (Date.now() - move.unfrozen_at.getTime()));
        return "later";
      }
      return purgeSource(db, event, move, await cellData(move.source_cell));
    case "undoing":
      return finishUndo(db, event, move, await cellData(move.target_cell));
  }
}

async function copy(
  db: Pool,
  event: LifecycleEvent,
  move: MoveRow,
  config: MoveConfig,
  source: CellData,
  target: CellData,
): Promise<"later" | "verified"> {
  const orders = await drained(db, event, move.frozen_at, config, source, move.tenant_id, "move_drained");
  if (orders === "later") return "later";

  const catalog = await source.export("catalog", move.tenant_id);
  const exported: Checksums = { ...catalog.checksums, ...orders.checksums };
  // A copy an earlier attempt imported before crashing would make this import refuse.
  const cleared = await target.purgeAll(move.tenant_id);
  if (total(cleared.remaining) > 0) throw new Error(`the target still holds rows of the shop: ${JSON.stringify(cleared.remaining)}`);
  const imported: Checksums = {
    ...(await target.import("catalog", move.tenant_id, catalog.rows)),
    ...(await target.import("orders", move.tenant_id, orders.rows)),
  };
  const sourceNow: Checksums = {
    ...(await source.checksums("catalog", move.tenant_id)),
    ...(await source.checksums("orders", move.tenant_id)),
  };
  const mismatched = differences(exported, imported);
  const changed = differences(exported, sourceNow);
  if (mismatched.length > 0 || changed.length > 0) {
    throw new Error(`verification failed: ${[...mismatched.map((t) => `${t} differs in the target`), ...changed.map((t) => `${t} changed in the source`)].join("; ")}`);
  }
  await withTransaction(db, async (client) => {
    await client.query("UPDATE platform.tenant_moves SET step = 'verified', checksums = $2 WHERE event_id = $1", [event.eventId, exported]);
    await recordEvent(client, move.tenant_id, "move_verified", { cell: move.target_cell, checksums: exported, clearedFromTarget: cleared.deleted });
  });
  move.step = "verified";
  return "verified";
}

async function switchOver(db: Pool, event: LifecycleEvent, move: MoveRow, config: MoveConfig): Promise<MoveOutcome> {
  await withTransaction(db, async (client) => {
    const { rows } = await client.query<{ status: string; plan: string }>(
      "SELECT status, plan FROM platform.tenants WHERE id = $1 FOR UPDATE",
      [move.tenant_id],
    );
    if (rows[0]?.status !== "MOVING") throw new Error(`the shop is ${rows[0]?.status}, not MOVING`);
    await client.query("UPDATE platform.tenants SET cell = $2, plan = $3, status = 'ACTIVE' WHERE id = $1", [
      move.tenant_id,
      move.target_cell,
      move.plan_after,
    ]);
    const { rows: switched } = await client.query<{ frozen_ms: number }>(
      `UPDATE platform.tenant_moves SET step = 'switched', unfrozen_at = now() WHERE event_id = $1
       RETURNING (extract(epoch FROM unfrozen_at - frozen_at) * 1000)::int AS frozen_ms`,
      [event.eventId],
    );
    await recordEvent(
      client,
      move.tenant_id,
      "move_switched",
      { from: move.source_cell, to: move.target_cell, plan: { from: rows[0].plan, to: move.plan_after }, frozenMs: switched[0]!.frozen_ms },
      { from: "MOVING", to: "ACTIVE" },
    );
  });
  move.step = "switched";
  // The source is purged once every edge routes the shop to the target.
  await later(db, event, config.freezeGraceMs);
  return "later";
}

async function purgeSource(db: Pool, event: LifecycleEvent, move: MoveRow, source: CellData): Promise<MoveOutcome> {
  const { deleted, remaining } = await source.purgeAll(move.tenant_id);
  if (total(remaining) > 0) throw new Error(`rows of the shop remain in ${move.source_cell}: ${JSON.stringify(remaining)}`);
  await withTransaction(db, async (client) => {
    await client.query("UPDATE platform.tenant_moves SET step = 'done', finished_at = now() WHERE event_id = $1", [event.eventId]);
    await recordEvent(client, move.tenant_id, "move_source_purged", { cell: move.source_cell, deleted, remaining });
    await complete(client, event.eventId);
  });
  return "moved";
}

async function beginUndo(db: Pool, event: LifecycleEvent, move: MoveRow, reason: string): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query("UPDATE platform.tenants SET status = 'ACTIVE' WHERE id = $1 AND status = 'MOVING'", [move.tenant_id]);
    await client.query("UPDATE platform.tenant_moves SET step = 'undoing', reason = $2, unfrozen_at = now() WHERE event_id = $1", [
      event.eventId,
      reason,
    ]);
    await recordEvent(client, move.tenant_id, "move_failed", { reason, cell: move.source_cell }, { from: "MOVING", to: "ACTIVE" });
  });
  move.step = "undoing";
}

async function finishUndo(db: Pool, event: LifecycleEvent, move: MoveRow, target: CellData): Promise<MoveOutcome> {
  const { deleted, remaining } = await target.purgeAll(move.tenant_id);
  if (total(remaining) > 0) throw new Error(`rows of the shop remain in ${move.target_cell}: ${JSON.stringify(remaining)}`);
  await withTransaction(db, async (client) => {
    await client.query("UPDATE platform.tenant_moves SET step = 'undone', finished_at = now() WHERE event_id = $1", [event.eventId]);
    await recordEvent(client, move.tenant_id, "move_undone", { cell: move.target_cell, deleted, remaining });
    await complete(client, event.eventId);
  });
  return "undone";
}
