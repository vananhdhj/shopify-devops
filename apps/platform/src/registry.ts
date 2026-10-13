import type { Plan, TenantRoute, TenantStatus } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";

interface RouteRow {
  id: string;
  handle: string;
  name: string;
  status: TenantStatus;
  credential_version: number;
  cell: string | null;
  plan: Plan;
  internal: boolean;
}

/**
 * Every shop that has not been deleted, with its cell, for the routers. A deleted shop is simply
 * absent, so a router answers for it exactly as for an address that never named a shop.
 */
export async function routingTable(db: Queryable): Promise<TenantRoute[]> {
  const { rows } = await db.query<RouteRow>(
    `SELECT id, handle, name, status, credential_version, cell, plan, internal
       FROM platform.tenants
      WHERE status <> 'DELETED'
      ORDER BY handle`,
  );
  return rows.map((row) => ({
    id: row.id,
    handle: row.handle,
    name: row.name,
    status: row.status,
    credentialVersion: row.credential_version,
    cell: row.cell,
    plan: row.plan,
    internal: row.internal,
  }));
}

/** What a sign-in check needs: the shop's status, cell, credential, and credential version. */
export async function merchantCredential(
  db: Queryable,
  tenantId: string,
): Promise<{ status: TenantStatus; cell: string | null; hash: string; credentialVersion: number } | undefined> {
  const { rows } = await db.query<{
    status: TenantStatus;
    cell: string | null;
    merchant_password_hash: string;
    credential_version: number;
  }>("SELECT status, cell, merchant_password_hash, credential_version FROM platform.tenants WHERE id = $1", [tenantId]);
  const row = rows[0];
  return (
    row && { status: row.status, cell: row.cell, hash: row.merchant_password_hash, credentialVersion: row.credential_version }
  );
}
