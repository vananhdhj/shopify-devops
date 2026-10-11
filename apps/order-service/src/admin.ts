import type { AdminOrderList, OrderStatus, PaymentScenario } from "@shop/contracts";
import type { Queryable } from "@shop/service-kit";

interface SummaryRow {
  id: string;
  status: OrderStatus;
  payment_scenario: PaymentScenario;
  item_count: number;
  subtotal_minor: number;
  currency: string;
  created_at: Date;
}

const pageSize = 200;

/**
 * The Merchant's view: Confirmed orders (the ones awaiting fulfillment) always come first, so a
 * long history can't hide work to do; then newest first, capped at one page.
 */
export async function listOrders(db: Queryable): Promise<AdminOrderList> {
  const { rows } = await db.query<SummaryRow>(
    `SELECT o.id, o.status, o.payment_scenario, o.subtotal_minor, o.currency, o.created_at,
            (SELECT COALESCE(sum(quantity), 0)::int FROM orders.order_items i
              WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS item_count
       FROM orders.orders o
      ORDER BY (o.status = 'CONFIRMED') DESC, o.created_at DESC
      LIMIT $1`,
    [pageSize + 1],
  );
  const orders = rows.slice(0, pageSize).map((row) => ({
    id: row.id,
    status: row.status,
    paymentScenario: row.payment_scenario,
    itemCount: row.item_count,
    subtotalMinor: row.subtotal_minor,
    currency: row.currency,
    createdAt: row.created_at.toISOString(),
  }));
  return { orders, truncated: rows.length > pageSize };
}

export type FulfillResult = "fulfilled" | "order_not_found" | "illegal_transition";

/**
 * Confirmed → Fulfilled, with its status-history event; run inside one tenant transaction, so
 * both commit together. Any other current status is an illegal transition (the database
 * trigger refuses it too).
 */
export async function fulfillOrder(client: Queryable, orderId: string): Promise<FulfillResult> {
  const updated = await client.query(
    "UPDATE orders.orders SET status = 'FULFILLED' WHERE id = $1 AND status = 'CONFIRMED'",
    [orderId],
  );
  if (updated.rowCount === 0) {
    const exists = await client.query("SELECT 1 FROM orders.orders WHERE id = $1", [orderId]);
    return exists.rowCount === 0 ? "order_not_found" : "illegal_transition";
  }
  await client.query(
    "INSERT INTO orders.order_events (order_id, from_status, to_status) VALUES ($1, 'CONFIRMED', 'FULFILLED')",
    [orderId],
  );
  return "fulfilled";
}
