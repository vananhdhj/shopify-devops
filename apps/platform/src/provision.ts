import type { Pool } from "pg";
import type { Plan } from "@shop/contracts";
import { withTransaction } from "@shop/service-kit";
import type { CellCredentials } from "@shop/tenancy";
import { endpointsOf, place, roleFor } from "./cells.ts";
import { type LifecycleEvent, type ShopCheck, checkShop, complete, recordEvent, retryLater } from "./lifecycle.ts";

interface TenantRow {
  handle: string;
  name: string;
  status: string;
  cell: string | null;
  plan: Plan;
  internal: boolean;
}

async function load(db: Pool, tenantId: string): Promise<TenantRow | undefined> {
  const { rows } = await db.query<TenantRow>(
    "SELECT handle, name, status, cell, plan, internal FROM platform.tenants WHERE id = $1",
    [tenantId],
  );
  return rows[0];
}

export type ProvisionOutcome = "active" | "retry" | "nothing_to_do";

/**
 * Asks the shop's cell to give its synthetic shop a product to buy (idempotent: the cell keeps
 * one). Through the cell's catalog API with that cell's own token, as purges are.
 */
async function fillSyntheticCatalog(db: Pool, credentials: CellCredentials, tenantId: string, cell: string): Promise<boolean> {
  const endpoints = await endpointsOf(db, cell);
  const token = credentials.get(cell, "platform-cell-token");
  if (!endpoints || !token) return false;
  try {
    const res = await fetch(`${endpoints.catalogUrl}/internal/tenants/${tenantId}/synthetic-catalog`, {
      method: "POST",
      headers: { "x-platform-token": token },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Provisions one shop, step by step; every step looks at the shop's state first, so running this
 * again after a crash, or twice side by side, changes nothing already done and records each step
 * once. Pooled tenancy needs nothing created in the cell: the shop's rows appear on its first
 * write (ADR-0010).
 *   1. place it in a cell, unless signup already did (a shop entered without one, such as the
 *      platform's internal synthetic shop, waits here until a cell of its role has registered);
 *   2. for a cell's synthetic shop (internal), have the cell fill its catalog;
 *   3. activate it (the router picks that up within one refresh);
 *   4. check it through the router, retrying with backoff until it answers. A failed check is
 *      recorded and retried; it does not undo the activation.
 */
export async function provision(
  db: Pool,
  router: ShopCheck,
  credentials: CellCredentials,
  event: LifecycleEvent,
): Promise<ProvisionOutcome> {
  const tenant = await load(db, event.tenantId);
  if (!tenant) {
    await complete(db, event.eventId);
    return "nothing_to_do";
  }

  if (tenant.status === "PROVISIONING") {
    if (tenant.cell === null) {
      const role = roleFor(tenant.plan, tenant.internal);
      const cell = await withTransaction(db, async (client) => {
        // Another worker may have placed it meanwhile; the row lock makes that visible here.
        const { rows } = await client.query<{ cell: string | null }>(
          "SELECT cell FROM platform.tenants WHERE id = $1 FOR UPDATE",
          [event.tenantId],
        );
        if (rows[0]?.cell) return rows[0].cell;
        const placed = await place(client, event.tenantId, role);
        if (placed) await recordEvent(client, event.tenantId, "placed", { cell: placed });
        return placed;
      });
      if (!cell) {
        await retryLater(db, event);
        return "retry";
      }
    }
    const placed = await load(db, event.tenantId);
    if (placed?.internal && placed.cell && !(await fillSyntheticCatalog(db, credentials, event.tenantId, placed.cell))) {
      await recordEvent(db, event.tenantId, "catalog_failed", { cell: placed.cell, attempt: event.attempts });
      await retryLater(db, event);
      return "retry";
    }
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
