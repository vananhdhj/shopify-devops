import type { Pool, PoolClient } from "pg";
import type {
  InventoryEffectAction as EffectAction,
  InventoryEffectLine as EffectLine,
  InventoryEffectOutcome as EffectOutcome,
} from "@shop/contracts";
import { withTransaction } from "@shop/service-kit";

/**
 * Applies one Inventory effect at most once per (Order, action). The Stock change and its
 * deduplication record commit together; a repeated request returns the recorded outcome
 * without touching Stock. A deduction takes every line or none. A release returns exactly
 * what the Order's applied deduction took (the request's own items are ignored).
 */
export async function applyInventoryEffect(
  db: Pool,
  orderId: string,
  action: EffectAction,
  items: EffectLine[],
): Promise<EffectOutcome> {
  return withTransaction(db, async (client) => {
    // Serialise every effect for one Order, so a concurrent retry waits for the first attempt
    // and then reads its recorded outcome instead of racing it.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [orderId]);

    const recorded = await recordedEffect(client, orderId, action);
    if (recorded) return recorded.outcome;
    return action === "deduct" ? deduct(client, orderId, items) : release(client, orderId);
  });
}

async function recordedEffect(client: PoolClient, orderId: string, action: EffectAction) {
  const { rows } = await client.query<{ outcome: EffectOutcome; items: EffectLine[] }>(
    "SELECT outcome, items FROM catalog.inventory_effects WHERE order_id = $1 AND action = $2",
    [orderId, action],
  );
  return rows[0];
}

/** Locks the products' rows in id order, so concurrent effects on overlapping products can't deadlock. */
async function lockStock(client: PoolClient, lines: EffectLine[]): Promise<Map<string, number>> {
  const { rows } = await client.query<{ id: string; stock: number }>(
    "SELECT id, stock FROM catalog.products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [lines.map((line) => line.productId)],
  );
  return new Map(rows.map((row) => [row.id, row.stock]));
}

async function record(
  client: PoolClient,
  orderId: string,
  action: EffectAction,
  outcome: EffectOutcome,
  items: EffectLine[],
): Promise<EffectOutcome> {
  await client.query(
    "INSERT INTO catalog.inventory_effects (order_id, action, outcome, items) VALUES ($1, $2, $3, $4)",
    [orderId, action, outcome, JSON.stringify(items)],
  );
  return outcome;
}

async function deduct(client: PoolClient, orderId: string, items: EffectLine[]): Promise<EffectOutcome> {
  const stock = await lockStock(client, items);
  const enough = items.every((line) => (stock.get(line.productId) ?? 0) >= line.quantity);
  if (!enough) return record(client, orderId, "deduct", "insufficient_stock", items);

  for (const line of items) {
    await client.query("UPDATE catalog.products SET stock = stock - $2 WHERE id = $1", [line.productId, line.quantity]);
  }
  return record(client, orderId, "deduct", "applied", items);
}

async function release(client: PoolClient, orderId: string): Promise<EffectOutcome> {
  const deduction = await recordedEffect(client, orderId, "deduct");
  if (deduction?.outcome !== "applied") return record(client, orderId, "release", "nothing_to_release", []);

  await lockStock(client, deduction.items);
  for (const line of deduction.items) {
    await client.query("UPDATE catalog.products SET stock = stock + $2 WHERE id = $1", [line.productId, line.quantity]);
  }
  return record(client, orderId, "release", "applied", deduction.items);
}
