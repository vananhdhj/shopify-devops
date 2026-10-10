import type { Pool } from "pg";
import type { OrderStatus, PaymentScenario } from "@shop/contracts";
import { withTransaction } from "@shop/service-kit";
import type { InventoryClient } from "./inventory-client.ts";
import { simulatePayment } from "./payment.ts";

export type Settlement = "confirmed" | "rejected_out_of_stock" | "rejected_payment" | "already_settled";

export interface SettleDeps {
  db: Pool;
  inventory: InventoryClient;
  slowPaymentDelayMs: number;
}

type Terminal = Exclude<OrderStatus, "PENDING" | "FULFILLED">;

const settlementFor: Record<Terminal, Settlement> = {
  CONFIRMED: "confirmed",
  REJECTED_OUT_OF_STOCK: "rejected_out_of_stock",
  REJECTED_PAYMENT: "rejected_payment",
};

/**
 * Moves a Pending order to its terminal state. Safe to run any number of times for one Order:
 * Inventory effects are deduplicated by (Order, action), the Payment scenario is stored, and
 * the status change only applies from PENDING. Any failure throws and the job retries, with
 * the Order still Pending.
 */
export async function settleOrder(deps: SettleDeps, orderId: string): Promise<Settlement> {
  const order = await loadOrder(deps.db, orderId);
  if (order?.status !== "PENDING") return "already_settled";

  const deduction = await deps.inventory.deduct(orderId, order.items);
  if (deduction === "insufficient_stock") return finish(deps.db, orderId, "REJECTED_OUT_OF_STOCK");

  const payment = await simulatePayment(order.paymentScenario, deps.slowPaymentDelayMs);
  if (payment === "approved") return finish(deps.db, orderId, "CONFIRMED");

  // Compensate before rejecting: if the release fails this throws, and the Order stays Pending.
  await deps.inventory.release(orderId);
  return finish(deps.db, orderId, "REJECTED_PAYMENT");
}

async function finish(db: Pool, orderId: string, to: Terminal): Promise<Settlement> {
  return (await transition(db, orderId, to)) ? settlementFor[to] : "already_settled";
}

async function loadOrder(db: Pool, orderId: string) {
  const { rows } = await db.query<{ status: OrderStatus; payment_scenario: PaymentScenario }>(
    "SELECT status, payment_scenario FROM orders.orders WHERE id = $1",
    [orderId],
  );
  const order = rows[0];
  if (!order) return undefined;
  const items = await db.query<{ product_id: string; quantity: number }>(
    "SELECT product_id, quantity FROM orders.order_items WHERE order_id = $1",
    [orderId],
  );
  return {
    status: order.status,
    paymentScenario: order.payment_scenario,
    items: items.rows.map((row) => ({ productId: row.product_id, quantity: row.quantity })),
  };
}

/** PENDING → `to` plus its status-history event, atomically; false if the Order already left PENDING. */
async function transition(db: Pool, orderId: string, to: Terminal): Promise<boolean> {
  return withTransaction(db, async (client) => {
    const updated = await client.query(
      "UPDATE orders.orders SET status = $2 WHERE id = $1 AND status = 'PENDING'",
      [orderId, to],
    );
    if (updated.rowCount === 0) return false;
    await client.query(
      "INSERT INTO orders.order_events (order_id, from_status, to_status) VALUES ($1, 'PENDING', $2)",
      [orderId, to],
    );
    return true;
  });
}
