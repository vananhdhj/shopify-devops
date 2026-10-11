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

/** What a sign-in check needs: the shop's status, credential, and credential version. */
export async function merchantCredential(
  db: Queryable,
  tenantId: string,
): Promise<{ status: TenantStatus; hash: string; credentialVersion: number } | undefined> {
  const { rows } = await db.query<{ status: TenantStatus; merchant_password_hash: string; credential_version: number }>(
    "SELECT status, merchant_password_hash, credential_version FROM platform.tenants WHERE id = $1",
    [tenantId],
  );
  const row = rows[0];
  return row && { status: row.status, hash: row.merchant_password_hash, credentialVersion: row.credential_version };
}
