import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { CheckoutRefusal, CheckoutRequest } from "@shop/contracts";
import { withTransaction } from "@shop/service-kit";
import { fetchCart } from "./catalog-client.ts";

export type CheckoutResult =
  | { outcome: "accepted"; orderId: string }
  | { outcome: "refused"; reason: CheckoutRefusal };

/** Covers Cart id and Payment scenario only: the item snapshot is the record of what was bought (ADR-0001). */
function requestHash(request: CheckoutRequest): string {
  return createHash("sha256").update(`${request.cartToken}\n${request.paymentScenario}`).digest("hex");
}

/** The Order a Checkout key already produced, judged against this request's hash. */
async function priorCheckout(db: Pool, request: CheckoutRequest): Promise<CheckoutResult | undefined> {
  const { rows } = await db.query<{ id: string; request_hash: string }>(
    "SELECT id, request_hash FROM orders.orders WHERE checkout_key = $1",
    [request.checkoutKey],
  );
  const prior = rows[0];
  if (!prior) return undefined;
  return prior.request_hash === requestHash(request)
    ? { outcome: "accepted", orderId: prior.id }
    : { outcome: "refused", reason: "checkout_key_reused" };
}

/**
 * Turns a Cart into a Pending order. A retry with the same Checkout key and request returns
 * the original Order; the same key with a different request, or a second Checkout of a Cart
 * that already became an Order, is refused. Order, item snapshot, and outbox event are
 * written in one transaction. Callers pass the cart token already normalised to lower case,
 * so a retry that spells the same token differently hashes identically.
 */
export async function acceptCheckout(db: Pool, catalogApiUrl: string, request: CheckoutRequest): Promise<CheckoutResult> {
  const prior = await priorCheckout(db, request);
  if (prior) return prior;

  const cart = await fetchCart(catalogApiUrl, request.cartToken);
  if (!cart) return { outcome: "refused", reason: "cart_not_found" };
  if (cart.items.length === 0) return { outcome: "refused", reason: "cart_empty" };

  try {
    const orderId = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO orders.orders (checkout_key, request_hash, source_cart_id, payment_scenario, subtotal_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [request.checkoutKey, requestHash(request), cart.id, request.paymentScenario, cart.subtotalMinor, cart.currency],
      );
      const id = rows[0]!.id;
      await client.query(
        `INSERT INTO orders.order_items (order_id, product_id, name, unit_price_minor, quantity)
         SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::int[], $5::int[])`,
        [
          id,
          cart.items.map((item) => item.productId),
          cart.items.map((item) => item.name),
          cart.items.map((item) => item.priceMinor),
          cart.items.map((item) => item.quantity),
        ],
      );
      await client.query(
        "INSERT INTO orders.outbox (order_id, event_type, payload) VALUES ($1, 'order.accepted', $2)",
        [id, { orderId: id }],
      );
      return id;
    });
    return { outcome: "accepted", orderId };
  } catch (err) {
    // A concurrent retry with the same key, or another Checkout of the same Cart, won the race.
    const constraint = (err as { code?: string; constraint?: string }).code === "23505"
      ? (err as { constraint?: string }).constraint
      : undefined;
    if (constraint === "orders_checkout_key_key") return (await priorCheckout(db, request))!;
    if (constraint === "orders_source_cart_id_key") return { outcome: "refused", reason: "cart_already_ordered" };
    throw err;
  }
}
