import type { Pool } from "pg";
import type { Order, OrderStatus, PaymentScenario } from "@shop/contracts";

interface OrderRow {
  id: string;
  status: OrderStatus;
  payment_scenario: PaymentScenario;
  subtotal_minor: number;
  currency: string;
  created_at: Date;
}

interface OrderItemRow {
  product_id: string;
  name: string;
  unit_price_minor: number;
  quantity: number;
}

export async function findOrder(db: Pool, id: string): Promise<Order | undefined> {
  const orders = await db.query<OrderRow>(
    "SELECT id, status, payment_scenario, subtotal_minor, currency, created_at FROM orders.orders WHERE id = $1",
    [id],
  );
  const order = orders.rows[0];
  if (!order) return undefined;

  const items = await db.query<OrderItemRow>(
    "SELECT product_id, name, unit_price_minor, quantity FROM orders.order_items WHERE order_id = $1 ORDER BY name",
    [id],
  );
  return {
    id: order.id,
    status: order.status,
    paymentScenario: order.payment_scenario,
    items: items.rows.map((item) => ({
      productId: item.product_id,
      name: item.name,
      unitPriceMinor: item.unit_price_minor,
      quantity: item.quantity,
      lineTotalMinor: item.unit_price_minor * item.quantity,
    })),
    subtotalMinor: order.subtotal_minor,
    currency: order.currency,
    createdAt: order.created_at.toISOString(),
  };
}
