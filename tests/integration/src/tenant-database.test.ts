import { describe, expect, it } from "vitest";
import type pg from "pg";
import { asIdentity, query } from "./db.ts";
import { meadowProducts, seedProducts } from "./seed.ts";
import { checkoutOf } from "./shopping.ts";
import { tenants } from "./tenants.ts";

const { harbor, meadow } = tenants;

const tenantTables = [
  "catalog.cart_items",
  "catalog.carts",
  "catalog.inventory_effects",
  "catalog.products",
  "orders.order_events",
  "orders.order_items",
  "orders.orders",
  "orders.outbox",
];

/** The tables each runtime identity may read at all (the order identity only appends to the others). */
const readableBy = {
  catalog: ["catalog.products", "catalog.carts", "catalog.cart_items", "catalog.inventory_effects"],
  orders: ["orders.orders", "orders.order_items"],
} as const;

type Identity = keyof typeof readableBy;

/**
 * Runs `work` as a runtime identity inside one transaction, with the tenant set as the services
 * set it (or not at all), and always rolls back, so nothing a probe manages to write survives.
 */
async function inTransaction<T>(identity: Identity, tenantId: string | null, work: (db: pg.Client) => Promise<T>): Promise<T> {
  return asIdentity(identity, async (db) => {
    await db.query("BEGIN");
    try {
      if (tenantId) await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return await work(db);
    } finally {
      await db.query("ROLLBACK");
    }
  });
}

/** The SQLSTATE a statement fails with, or "ok". */
async function outcome(db: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  await db.query("SAVEPOINT probe");
  try {
    await db.query(sql, params);
    await db.query("RELEASE SAVEPOINT probe");
    return "ok";
  } catch (err) {
    await db.query("ROLLBACK TO SAVEPOINT probe");
    return (err as { code?: string }).code ?? "error";
  }
}

describe("tenant isolation in the database", () => {
  it.each(Object.entries(readableBy) as [Identity, readonly string[]][])(
    "the %s identity sees no rows at all when no tenant is set",
    async (identity, tables) => {
      await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve"); // rows exist in every table
      await inTransaction(identity, null, async (db) => {
        for (const table of tables) {
          const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
          expect.soft(rows[0]?.n, table).toBe(0);
        }
      });
    },
  );

  it("refuses inserts when no tenant is set", async () => {
    // The tenant column defaults to the transaction's tenant; with none set it is NULL, which no
    // policy accepts (the policy check fails before the NOT NULL constraint would).
    expect(await inTransaction("catalog", null, (db) => outcome(db, "INSERT INTO catalog.carts DEFAULT VALUES"))).toBe("42501");
    expect(
      await inTransaction("orders", null, (db) =>
        outcome(
          db,
          `INSERT INTO orders.orders (checkout_key, request_hash, source_cart_id, payment_scenario, subtotal_minor, currency)
           VALUES ('probe-checkout-key', 'x', gen_random_uuid(), 'approve', 0, 'USD')`,
        ),
      ),
    ).toBe("42501");
  });

  it("shows one tenant none of another's rows, in every table", async () => {
    await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    for (const [identity, tables] of Object.entries(readableBy) as [Identity, readonly string[]][]) {
      await inTransaction(identity, meadow.id, async (db) => {
        for (const table of tables) {
          const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [harbor.id]);
          expect.soft(rows[0]?.n, table).toBe(0);
        }
      });
    }
  });

  it("lets one tenant change none of another's rows", async () => {
    const { orderId } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "decline");

    const stockUpdate = await inTransaction("catalog", meadow.id, (db) =>
      db.query("UPDATE catalog.products SET stock = stock + 100 WHERE id = $1", [seedProducts.lastLantern]),
    );
    expect(stockUpdate.rowCount).toBe(0);

    const statusUpdate = await inTransaction("orders", meadow.id, (db) =>
      db.query("UPDATE orders.orders SET status = 'CONFIRMED' WHERE id = $1", [orderId]),
    );
    expect(statusUpdate.rowCount).toBe(0);
  });

  it("refuses rows written for another tenant", async () => {
    // A row naming Harbor Goods, written in a Meadow Supply transaction, violates the policy.
    expect(
      await inTransaction("catalog", meadow.id, (db) =>
        outcome(db, "INSERT INTO catalog.carts (tenant_id) VALUES ($1)", [harbor.id]),
      ),
    ).toBe("42501");
    expect(
      await inTransaction("orders", meadow.id, (db) =>
        outcome(
          db,
          `INSERT INTO orders.orders (tenant_id, checkout_key, request_hash, source_cart_id, payment_scenario, subtotal_minor, currency)
           VALUES ($1, 'probe-checkout-key', 'x', gen_random_uuid(), 'approve', 0, 'USD')`,
          [harbor.id],
        ),
      ),
    ).toBe("42501");
  });

  it("refuses a Cart line naming another tenant's product, whoever writes it", async () => {
    // The composite foreign key holds even for the migration identity, which RLS does not limit.
    const [cart] = await query<{ id: string }>("INSERT INTO catalog.carts (tenant_id) VALUES ($1) RETURNING id", [harbor.id]);
    await expect(
      query("INSERT INTO catalog.cart_items (tenant_id, cart_id, product_id, quantity) VALUES ($1, $2, $3, 1)", [
        harbor.id,
        cart!.id,
        meadowProducts.gardenTwine,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("tenant schema", () => {
  it("gives every table a non-null tenant key and row-level security with policies", async () => {
    const tables = await query<{ name: string; has_tenant: boolean; rls: boolean; policies: number }>(
      `SELECT format('%s.%s', n.nspname, c.relname) AS name,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull AND NOT a.attisdropped) AS has_tenant,
              c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('catalog', 'orders') AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
        ORDER BY 1`,
    );
    expect(tables.map((table) => table.name)).toEqual(tenantTables);
    for (const table of tables) {
      expect.soft(table, table.name).toMatchObject({ has_tenant: true, rls: true, policies: expect.any(Number) });
      expect.soft(table.policies, table.name).toBeGreaterThan(0);
    }
  });

  it("gives no runtime identity a way around row-level security", async () => {
    const roles = await query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean; owns: number }>(
      `SELECT r.rolname, r.rolbypassrls, r.rolsuper,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owns
         FROM pg_roles r WHERE r.rolname IN ('catalog_app', 'order_app') ORDER BY 1`,
    );
    expect(roles).toEqual([
      { rolname: "catalog_app", rolbypassrls: false, rolsuper: false, owns: 0 },
      { rolname: "order_app", rolbypassrls: false, rolsuper: false, owns: 0 },
    ]);
  });

  it("gives the order identity the outbox only through the narrow functions", async () => {
    expect(await inTransaction("orders", harbor.id, (db) => outcome(db, "SELECT 1 FROM orders.outbox"))).toBe("42501");
    expect(
      await inTransaction("orders", harbor.id, (db) => outcome(db, "UPDATE orders.outbox SET dispatched_at = now()")),
    ).toBe("42501");
  });
});
