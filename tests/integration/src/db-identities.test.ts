import { describe, expect, it } from "vitest";
import { asIdentity } from "./db.ts";
import { seedProducts } from "./seed.ts";

async function attempt(identity: "catalog" | "orders", sql: string, params: unknown[] = []): Promise<string> {
  return asIdentity(identity, async (db) => {
    try {
      await db.query(sql, params);
      return "allowed";
    } catch (err) {
      return (err as { code?: string }).code === "42501" ? "denied" : `error ${(err as Error).message}`;
    }
  });
}

describe("database identities", () => {
  it.each([
    ["read orders", "SELECT 1 FROM orders.orders LIMIT 1"],
    ["write orders", "INSERT INTO orders.outbox (order_id, event_type, payload) VALUES (gen_random_uuid(), 'x', '{}')"],
  ])("the catalog identity cannot %s", async (_label, sql) => {
    expect(await attempt("catalog", sql)).toBe("denied");
  });

  it.each([
    ["update Stock", "UPDATE catalog.products SET stock = stock + 1 WHERE id = $1", [seedProducts.enamelMug]],
    ["insert products", "INSERT INTO catalog.products (name, price_minor, stock) VALUES ('x', 1, 1)", []],
    ["write Carts", "INSERT INTO catalog.carts DEFAULT VALUES", []],
  ])("the order identity cannot %s", async (_label, sql, params) => {
    expect(await attempt("orders", sql, params)).toBe("denied");
  });

  it("the order identity cannot rewrite an Order's item snapshot", async () => {
    expect(await attempt("orders", "UPDATE orders.order_items SET quantity = quantity + 1")).toBe("denied");
  });
});
