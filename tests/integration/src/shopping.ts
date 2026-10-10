import { randomUUID } from "node:crypto";
import type { Cart, CheckoutAccepted, Order, PaymentScenario } from "@shop/contracts";
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
