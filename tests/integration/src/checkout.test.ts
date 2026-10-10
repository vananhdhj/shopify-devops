import { describe, expect, it } from "vitest";
import { query } from "./db.ts";
import { catalogApiUrl } from "./http.ts";
import { seedProducts } from "./seed.ts";
import { cartWith, checkout, newCheckoutKey, readOrder } from "./shopping.ts";

describe("checkout", () => {
  it("accepts a Cart as a Pending order with an Order token, snapshotting items at server-owned prices", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 2, [seedProducts.woolSocks]: 1 });

    const accepted = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ orderId: expect.any(String), orderToken: expect.any(String), status: "PENDING" });

    const order = await readOrder(accepted.body.orderId, accepted.body.orderToken);
    expect(order.status).toBe(200);
    // Expected prices come from the seed data: Notebook Set 1200, Wool Socks 1600.
    expect(order.body).toEqual({
      id: accepted.body.orderId,
      status: "PENDING",
      paymentScenario: "approve",
      items: [
        { productId: seedProducts.notebookSet, name: "Notebook Set", unitPriceMinor: 1200, quantity: 2, lineTotalMinor: 2400 },
        { productId: seedProducts.woolSocks, name: "Wool Socks", unitPriceMinor: 1600, quantity: 1, lineTotalMinor: 1600 },
      ],
      subtotalMinor: 4000,
      currency: "USD",
      createdAt: expect.any(String),
    });
  });

  it("returns the original Order to 100 concurrent retries of one Checkout, creating exactly one", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const request = { cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" };

    const responses = await Promise.all(Array.from({ length: 100 }, () => checkout(request)));

    expect(new Set(responses.map((r) => r.status))).toEqual(new Set([202]));
    expect(new Set(responses.map((r) => r.body.orderId)).size).toBe(1);
    expect(new Set(responses.map((r) => r.body.orderToken)).size).toBe(1);
    expect(await query("SELECT id FROM orders.orders WHERE source_cart_id = $1", [cart.id])).toHaveLength(1);
    expect(await query("SELECT event_id FROM orders.outbox WHERE order_id = $1", [responses[0]!.body.orderId])).toHaveLength(1);
  });

  it("treats a retry that spells the cart token in a different letter case as the same Checkout", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const checkoutKey = newCheckoutKey();
    const first = await checkout({ cartToken: cart.id, checkoutKey, paymentScenario: "approve" });

    const retry = await checkout({ cartToken: cart.id.toUpperCase(), checkoutKey, paymentScenario: "approve" });

    expect(retry).toMatchObject({ status: 202, body: { orderId: first.body.orderId } });
  });

  it("refuses a reused Checkout key whose Cart or Payment scenario changed", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const otherCart = await cartWith({ [seedProducts.woolSocks]: 1 });
    const checkoutKey = newCheckoutKey();
    await checkout({ cartToken: cart.id, checkoutKey, paymentScenario: "approve" });

    expect(await checkout({ cartToken: cart.id, checkoutKey, paymentScenario: "decline" })).toMatchObject({
      status: 409,
      body: { error: "checkout_key_reused" },
    });
    expect(await checkout({ cartToken: otherCart.id, checkoutKey, paymentScenario: "approve" })).toMatchObject({
      status: 409,
      body: { error: "checkout_key_reused" },
    });
    expect(await query("SELECT id FROM orders.orders WHERE source_cart_id = $1", [otherCart.id])).toHaveLength(0);
  });

  it("refuses a second Checkout of a Cart that already became an Order (ADR-0001)", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });

    const second = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });

    expect(second).toMatchObject({ status: 409, body: { error: "cart_already_ordered" } });
    expect(await query("SELECT id FROM orders.orders WHERE source_cart_id = $1", [cart.id])).toHaveLength(1);
  });

  it("keeps the Order's snapshot when the Cart is edited afterwards", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const accepted = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });

    await fetch(`${catalogApiUrl}/carts/${cart.id}/items/${seedProducts.notebookSet}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 7 }),
    });

    const order = await readOrder(accepted.body.orderId, accepted.body.orderToken);
    expect(order.body.items).toEqual([expect.objectContaining({ productId: seedProducts.notebookSet, quantity: 1 })]);
    expect(order.body.subtotalMinor).toBe(1200);
  });

  it("lets only the Order token read an Order, and never stores the token", async () => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const { body } = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });

    expect(await readOrder(body.orderId)).toMatchObject({ status: 404, body: { error: "order_not_found" } });
    expect(await readOrder(body.orderId, "not-the-token")).toMatchObject({ status: 404, body: { error: "order_not_found" } });
    expect(await readOrder(body.orderId, `${body.orderToken.slice(0, -1)}x`)).toMatchObject({ status: 404 });

    const stored = await query("SELECT * FROM orders.orders WHERE id = $1", [body.orderId]);
    expect(JSON.stringify(stored)).not.toContain(body.orderToken);
  });

  it.each([
    ["an unknown Cart", { cartToken: "00000000-0000-4000-8000-00000000beef" }, 404, "cart_not_found"],
    ["a malformed cart token", { cartToken: "nope" }, 404, "cart_not_found"],
    ["an unknown Payment scenario", { paymentScenario: "maybe" }, 400, "invalid_request"],
    ["a Checkout key shorter than 8 characters", { checkoutKey: "short" }, 400, "invalid_request"],
  ])("refuses %s", async (_label, override, status, error) => {
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const res = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve", ...override });
    expect(res).toMatchObject({ status, body: { error } });
  });

  it("refuses an empty Cart with 422", async () => {
    const cart = await cartWith({});
    const res = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });
    expect(res).toMatchObject({ status: 422, body: { error: "cart_empty" } });
  });
});
