import type { Pool } from "pg";
import { withTransaction } from "@shop/service-kit";
import { type LifecycleEvent, type ShopCheck, checkShop, complete, recordEvent, retryLater } from "./lifecycle.ts";

/** Phase 2 has one cell; placement by plan and capacity arrives with more cells (Phase 3). */
export const defaultCell = "cell-1";

interface TenantRow {
  handle: string;
  name: string;
  status: string;
  cell: string | null;
}

async function load(db: Pool, tenantId: string): Promise<TenantRow | undefined> {
  const { rows } = await db.query<TenantRow>("SELECT handle, name, status, cell FROM platform.tenants WHERE id = $1", [tenantId]);
  return rows[0];
}

export type ProvisionOutcome = "active" | "retry" | "nothing_to_do";

/**
 * Provisions one shop, step by step; every step looks at the shop's state first, so running this
 * again after a crash, or twice side by side, changes nothing already done and records each step
 * once. Pooled tenancy needs nothing created in the cell: the shop's rows appear on its first
 * write (ADR-0010).
 *   1. place it in a cell;  2. activate it (the router picks that up within one refresh);
 *   3. check it through the router, retrying with backoff until it answers. A failed check is
 *      recorded and retried; it does not undo the activation.
 */
export async function provision(db: Pool, router: ShopCheck, event: LifecycleEvent): Promise<ProvisionOutcome> {
  const tenant = await load(db, event.tenantId);
  if (!tenant) {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }

  if (tenant.status === "PROVISIONING") {
    await withTransaction(db, async (client) => {
      const placed = await client.query("UPDATE platform.tenants SET cell = $2 WHERE id = $1 AND cell IS NULL", [
        event.tenantId,
        defaultCell,
      ]);
      if (placed.rowCount === 1) await recordEvent(client, event.tenantId, "placed", { cell: defaultCell });
    });
    await withTransaction(db, async (client) => {
      const activated = await client.query(
        "UPDATE platform.tenants SET status = 'ACTIVE' WHERE id = $1 AND status = 'PROVISIONING'",
        [event.tenantId],
      );
      if (activated.rowCount === 1) {
        await recordEvent(client, event.tenantId, "activated", {}, { from: "PROVISIONING", to: "ACTIVE" });
      }
    });
  }

  // Suspended or being deleted by the operator in the meantime: nothing left for provisioning.
  const current = await load(db, event.tenantId);
  if (current?.status !== "ACTIVE") {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }

  const check = await checkShop(router, current.handle, current.name);
  if (!check.ok) {
    await recordEvent(db, event.tenantId, "check_failed", { status: check.status, attempt: event.attempts });
    await retryLater(db, event);
    return "retry";
  }
  await withTransaction(db, async (client) => {
    await recordEvent(client, event.tenantId, "checked", { status: check.status, attempt: event.attempts });
    await complete(client, event.eventId);
  });
  return "active";
}
