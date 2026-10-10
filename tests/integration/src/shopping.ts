import { randomUUID } from "node:crypto";
import type { Cart, CheckoutAccepted, Order, PaymentScenario } from "@shop/contracts";
import { query } from "./db.ts";
import { catalogApiUrl, orderServiceUrl } from "./http.ts";

/** Creates a Cart holding the given products and quantities, through the catalog API. */
export async function cartWith(lines: Record<string, number>): Promise<Cart> {
  const cart = (await (await fetch(`${catalogApiUrl}/carts`, { method: "POST" })).json()) as Cart;
  for (const [productId, quantity] of Object.entries(lines)) {
    await fetch(`${catalogApiUrl}/carts/${cart.id}/items/${productId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
  }
  return cart;
}

export function newCheckoutKey(): string {
  return `test-${randomUUID()}`;
}

export async function checkout(body: {
  cartToken: string;
  checkoutKey: string;
  paymentScenario: PaymentScenario | string;
}): Promise<{ status: number; body: CheckoutAccepted & { error?: string } }> {
  const res = await fetch(`${orderServiceUrl}/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as CheckoutAccepted & { error?: string } };
}

export async function readOrder(
  orderId: string,
  orderToken?: string,
): Promise<{ status: number; body: Order & { error?: string } }> {
  const headers: Record<string, string> = orderToken ? { "x-order-token": orderToken } : {};
  const res = await fetch(`${orderServiceUrl}/orders/${orderId}`, { headers });
  return { status: res.status, body: (await res.json()) as Order & { error?: string } };
}

/** Polls an Order until it leaves PENDING (or the timeout passes) and returns its final read. */
export async function settled(orderId: string, orderToken: string, timeoutMs = 20_000): Promise<Order> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await readOrder(orderId, orderToken);
    if (body.status !== "PENDING" || Date.now() > deadline) return body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Checks out a fresh Cart holding the given lines and returns the accepted Order's id and token. */
export async function checkoutOf(
  lines: Record<string, number>,
  paymentScenario: PaymentScenario,
): Promise<{ orderId: string; orderToken: string }> {
  const cart = await cartWith(lines);
  const { status, body } = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario });
  if (status !== 202) throw new Error(`checkout answered ${status}`);
  return body;
}

export function statusChanges(orderId: string) {
  return query<{ from_status: string; to_status: string }>(
    "SELECT from_status, to_status FROM orders.order_events WHERE order_id = $1 ORDER BY created_at",
    [orderId],
  );
}

