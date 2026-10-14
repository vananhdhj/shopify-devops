import type { CellRegistration, CellRole, CellRoute, Plan } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";
import { withTransaction } from "@shop/service-kit";
import type { Pool } from "pg";

/** Where a registered cell's APIs answer. */
export interface CellEndpoints {
  id: string;
  storefrontUrl: string;
  catalogUrl: string;
  ordersUrl: string;
}

/** The role of the cells a shop may be placed in: internal shops go to the canary only. */
export function roleFor(plan: Plan, internal: boolean): CellRole {
  if (internal) return "canary";
  return plan === "plus" ? "dedicated" : "pooled";
}

export interface Candidate {
  id: string;
  capacity: number;
  /** Shops placed in the cell and not yet deleted, its synthetic shop aside. */
  shops: number;
}

/**
 * The cell a new shop goes to among the registered cells of its role: the one with the fewest
 * shops that still has room (ties broken by id, so the choice is repeatable). A dedicated cell
 * has room for one shop, so a plus shop only ever lands in an empty one. Undefined: no room.
 */
export function choose(candidates: Candidate[]): string | undefined {
  return candidates
    .filter((cell) => cell.shops < cell.capacity)
    .sort((a, b) => a.shops - b.shops || a.id.localeCompare(b.id))[0]?.id;
}

/**
 * Places one shop, inside the caller's transaction. Every registered cell of the role is locked
 * first, so two placements of the same role run one after the other and see each other's shop:
 * two plus signups cannot both take the last dedicated cell. Returns the cell, or undefined when
 * none has room.
 */
export async function place(client: Queryable, tenantId: string, role: CellRole): Promise<string | undefined> {
  const { rows } = await client.query<{ id: string; capacity: number }>(
    "SELECT id, capacity FROM platform.cells WHERE role = $1 AND registered_at IS NOT NULL ORDER BY id FOR UPDATE",
    [role],
  );
  if (rows.length === 0) return undefined;
  const shops = await shopsIn(client, rows.map((row) => row.id));
  const cell = choose(rows.map((row) => ({ id: row.id, capacity: row.capacity, shops: shops.get(row.id) ?? 0 })));
  if (cell) await client.query("UPDATE platform.tenants SET cell = $2 WHERE id = $1 AND cell IS NULL", [tenantId, cell]);
  return cell;
}

/**
 * Shops each cell holds against its capacity: those placed in it and not deleted, its synthetic
 * shop aside, plus those moving into it (Phase 6), so a signup cannot take a cell a move will fill.
 */
export async function shopsIn(client: Queryable, cells: string[]): Promise<Map<string, number>> {
  const { rows } = await client.query<{ cell: string; n: number }>(
    `SELECT cell, count(*)::int AS n FROM (
       SELECT cell FROM platform.tenants WHERE cell = ANY($1) AND status <> 'DELETED' AND NOT internal
       UNION ALL
       SELECT target_cell FROM platform.tenant_moves WHERE target_cell = ANY($1) AND finished_at IS NULL
     ) AS taken GROUP BY cell`,
    [cells],
  );
  return new Map(rows.map((row) => [row.cell, row.n]));
}

export type RegistrationResult = { outcome: "registered"; created: boolean } | { outcome: "refused"; reason: string };

/** The handle of a cell's synthetic shop. */
export const syntheticHandle = (cell: string) => `synthetic-${cell}`;

/**
 * Gives the cell its synthetic shop unless it holds one: an internal shop, placed in the cell
 * directly and provisioned like any other (the outbox), whose catalog the cell's API fills
 * (`provision`). It is outside the cell's capacity. The canary cell's seeded shop (`canary`, from
 * Phase 3) counts as its synthetic shop. Inside the registration's transaction, under the cell's
 * row lock, so two registrations of one cell cannot both create it.
 */
async function ensureSyntheticShop(client: Queryable, cell: string): Promise<void> {
  const { rows } = await client.query("SELECT 1 FROM platform.tenants WHERE cell = $1 AND internal AND status <> 'DELETED'", [cell]);
  if (rows.length > 0) return;
  const handle = syntheticHandle(cell);
  // No password matches the hash 'unusable', so nobody signs in as its Merchant.
  const created = await client.query<{ id: string }>(
    `INSERT INTO platform.tenants (handle, name, merchant_password_hash, internal, cell)
     VALUES ($1, $2, 'unusable', true, $3)
     ON CONFLICT (handle) DO NOTHING RETURNING id`,
    [handle, `Synthetic ${cell}`, cell],
  );
  // A deleted synthetic shop keeps its handle forever: the cell then goes without one.
  const id = created.rows[0]?.id;
  if (!id) return;
  await client.query(
    `INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
     VALUES ($1, NULL, 'PROVISIONING', 'created', 'registration', $2)`,
    [id, { handle, internal: true }],
  );
  await client.query("INSERT INTO platform.tenant_events (tenant_id, step, actor, detail) VALUES ($1, 'placed', 'registration', $2)", [
    id,
    { cell },
  ]);
  await client.query("INSERT INTO platform.lifecycle_outbox (tenant_id, action) VALUES ($1, 'provision')", [id]);
}

/**
 * Enters a cell into the directory, or updates its URLs and capacity, and makes sure it has its
 * synthetic shop: a cell registers on every sync, so registering again is the normal case. A cell
 * holding shops cannot change role, and its capacity cannot drop below the shops it holds; both
 * would strand shops placed by the old rules.
 */
export async function register(db: Pool, id: string, cell: CellRegistration): Promise<RegistrationResult> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ role: CellRole }>("SELECT role FROM platform.cells WHERE id = $1 FOR UPDATE", [id]);
    const existing = rows[0];
    if (existing) {
      const held = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM platform.tenants WHERE cell = $1 AND status <> 'DELETED' AND NOT internal",
        [id],
      );
      const shops = held.rows[0]!.n;
      if (existing.role !== cell.role && shops > 0) {
        return { outcome: "refused", reason: `cell ${id} holds ${shops} shops as ${existing.role}; its role cannot change` };
      }
      if (cell.capacity < shops) {
        return { outcome: "refused", reason: `cell ${id} holds ${shops} shops, more than a capacity of ${cell.capacity}` };
      }
      await client.query(
        `UPDATE platform.cells
            SET role = $2, capacity = $3, storefront_url = $4, catalog_url = $5, orders_url = $6,
                registered_at = coalesce(registered_at, now()), updated_at = now()
          WHERE id = $1`,
        [id, cell.role, cell.capacity, cell.storefrontUrl, cell.catalogUrl, cell.ordersUrl],
      );
      await ensureSyntheticShop(client, id);
      return { outcome: "registered", created: false };
    }
    await client.query(
      `INSERT INTO platform.cells (id, role, capacity, storefront_url, catalog_url, orders_url, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [id, cell.role, cell.capacity, cell.storefrontUrl, cell.catalogUrl, cell.ordersUrl],
    );
    await ensureSyntheticShop(client, id);
    return { outcome: "registered", created: true };
  });
}

/** A registered cell's endpoints, or undefined for an unknown or unregistered cell. */
export async function endpointsOf(db: Queryable, id: string): Promise<CellEndpoints | undefined> {
  const { rows } = await db.query<{ id: string; storefront_url: string; catalog_url: string; orders_url: string }>(
    "SELECT id, storefront_url, catalog_url, orders_url FROM platform.cells WHERE id = $1 AND registered_at IS NOT NULL",
    [id],
  );
  const row = rows[0];
  return row && { id: row.id, storefrontUrl: row.storefront_url, catalogUrl: row.catalog_url, ordersUrl: row.orders_url };
}

/** Every registered cell, for the edge's routing table. */
export async function cellRoutes(db: Queryable): Promise<CellRoute[]> {
  const { rows } = await db.query<{ id: string; storefront_url: string }>(
    "SELECT id, storefront_url FROM platform.cells WHERE registered_at IS NOT NULL ORDER BY id",
  );
  return rows.map((row) => ({ id: row.id, storefrontUrl: row.storefront_url }));
}
