import type { TenantRoute, TenantStatus } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";

interface RouteRow {
  id: string;
  handle: string;
  name: string;
  status: TenantStatus;
  credential_version: number;
}

/**
 * Every shop that has not been deleted, for the routers. A deleted shop is simply absent, so a
 * router answers for it exactly as for an address that never named a shop.
 */
export async function routingTable(db: Queryable): Promise<TenantRoute[]> {
  const { rows } = await db.query<RouteRow>(
    `SELECT id, handle, name, status, credential_version
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
  }));
}
