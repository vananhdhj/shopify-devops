import type { Pool } from "pg";
import { type Queryable, withTransaction } from "@shop/service-kit";

export interface TenantSummary {
  id: string;
  handle: string;
  name: string;
  status: string;
  plan: string;
  cell: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listTenants(db: Queryable): Promise<TenantSummary[]> {
  const { rows } = await db.query<{
    id: string;
    handle: string;
    name: string;
    status: string;
    plan: string;
    cell: string | null;
    created_at: Date;
    updated_at: Date;
  }>("SELECT id, handle, name, status, plan, cell, created_at, updated_at FROM platform.tenants ORDER BY created_at");
  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    name: row.name,
    status: row.status,
    plan: row.plan,
    cell: row.cell,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function tenantEvents(db: Queryable, handle: string) {
  const { rows } = await db.query<{
    step: string;
    from_status: string | null;
    to_status: string | null;
    actor: string;
    detail: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT e.step, e.from_status, e.to_status, e.actor, e.detail, e.created_at
       FROM platform.tenant_events e JOIN platform.tenants t ON t.id = e.tenant_id
      WHERE t.handle = $1
      ORDER BY e.created_at`,
    [handle],
  );
  return rows.map((row) => ({
    step: row.step,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actor: row.actor,
    detail: row.detail,
    at: row.created_at.toISOString(),
  }));
}

export type OperatorAction = "suspend" | "reinstate" | "delete";

/** The status each action moves a shop to, and the statuses it may move from. */
const moves: Record<OperatorAction, { to: string; from: string[] }> = {
  suspend: { to: "SUSPENDED", from: ["ACTIVE"] },
  reinstate: { to: "ACTIVE", from: ["SUSPENDED"] },
  delete: { to: "DELETING", from: ["ACTIVE", "SUSPENDED"] },
};

export type OperatorResult =
  | { outcome: "done"; tenantId: string; status: string }
  | { outcome: "not_found" }
  | { outcome: "not_allowed"; status: string };

/**
 * One operator action on one shop, with its audit event, in one transaction. Suspension and
 * reinstatement act at the routers only (within one routing refresh) and change no shop data; a
 * deletion also asks the lifecycle worker to purge the shop from its cell. Repeating an action
 * already in effect is refused as not allowed, so the audit trail records each move once.
 */
export async function act(db: Pool, handle: string, action: OperatorAction): Promise<OperatorResult> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM platform.tenants WHERE handle = $1 FOR UPDATE",
      [handle],
    );
    const tenant = rows[0];
    if (!tenant) return { outcome: "not_found" };
    const move = moves[action];
    if (!move.from.includes(tenant.status)) return { outcome: "not_allowed", status: tenant.status };

    await client.query("UPDATE platform.tenants SET status = $2 WHERE id = $1", [tenant.id, move.to]);
    await client.query(
      `INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor)
       VALUES ($1, $2, $3, $4, 'operator')`,
      [tenant.id, tenant.status, move.to, action],
    );
    if (action === "delete") {
      await client.query("INSERT INTO platform.lifecycle_outbox (tenant_id, action) VALUES ($1, 'delete')", [tenant.id]);
    }
    return { outcome: "done", tenantId: tenant.id, status: move.to };
  });
}
