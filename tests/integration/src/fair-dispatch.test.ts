import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Cart, CheckoutAccepted } from "@shop/contracts";
import { planLimits, type TenantContext } from "@shop/tenancy";
import { adminToken } from "./admin.ts";
import { query } from "./db.ts";
import { api, catalogApiUrl, orderServiceUrl } from "./http.ts";
import { newCheckoutKey } from "./shopping.ts";

const json = { "content-type": "application/json" };
const freshShop = (): TenantContext => ({
  id: randomUUID(),
  handle: `fd-${randomUUID().slice(0, 8)}`,
  name: "Fair Dispatch",
  credentialVersion: 1,
  plan: "starter",
});

async function productOf(shop: TenantContext): Promise<string> {
  const res = await api(
    `${catalogApiUrl}/admin/products`,
    { method: "POST", headers: { ...json, "x-admin-token": adminToken() }, body: JSON.stringify({ name: "Burst Item", priceMinor: 100, stock: 1_000 }) },
    shop,
  );
  return ((await res.json()) as { id: string }).id;
}

/** One Order for `shop`, through a fresh Cart; checked out one at a time (the shop's Checkout cap). */
async function orderFor(shop: TenantContext, productId: string, paymentScenario: string): Promise<string> {
  const cart = (await (await api(`${catalogApiUrl}/carts`, { method: "POST" }, shop)).json()) as Cart;
  await api(`${catalogApiUrl}/carts/${cart.id}/items/${productId}`, { method: "PUT", headers: json, body: JSON.stringify({ quantity: 1 }) }, shop);
  const res = await api(
    `${orderServiceUrl}/checkout`,
    { method: "POST", headers: json, body: JSON.stringify({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario }) },
    shop,
  );
  expect(res.status).toBe(202);
  return ((await res.json()) as CheckoutAccepted).orderId;
}

const statusOf = async (orderId: string) =>
  (await query<{ status: string }>("SELECT status FROM orders.orders WHERE id = $1", [orderId]))[0]?.status;
const pendingOf = async (shop: TenantContext) =>
  (await query<{ n: number }>("SELECT count(*)::int AS n FROM orders.orders WHERE tenant_id = $1 AND status = 'PENDING'", [shop.id]))[0]!.n;

describe("fair dispatch", () => {
  it("settles another shop's Order while one shop's burst of slow Orders is still waiting", async () => {
    const noisy = freshShop();
    const quiet = freshShop();
    const [noisyProduct, quietProduct] = await Promise.all([productOf(noisy), productOf(quiet)]);

    // 50 Orders whose simulated payment takes 3 s each: at 5 jobs at a time, a FIFO queue would
    // keep them busy for about 30 s.
    for (let i = 0; i < 50; i++) await orderFor(noisy, noisyProduct, "slow");
    const started = Date.now();
    const quietOrder = await orderFor(quiet, quietProduct, "approve");

    await expect.poll(() => statusOf(quietOrder), { timeout: 20_000, interval: 250 }).toBe("CONFIRMED");
    const waited = (Date.now() - started) / 1000;
    // It went in ahead of most of the burst: well inside the FIFO's 30 s, with the burst mostly Pending.
    expect(waited).toBeLessThan(15);
    expect(await pendingOf(noisy)).toBeGreaterThan(20);

    // The burst never had more than K Orders in the queue at a time.
    const [inQueue] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders.outbox e JOIN orders.orders o ON o.tenant_id = e.tenant_id AND o.id = e.order_id
        WHERE e.tenant_id = $1 AND e.dispatched_at IS NOT NULL AND o.status = 'PENDING'`,
      [noisy.id],
    );
    expect(inQueue!.n).toBeLessThanOrEqual(planLimits.starter.admittedOrders);

    // And the burst still settles, all of it.
    await expect.poll(() => pendingOf(noisy), { timeout: 120_000, interval: 1_000 }).toBe(0);
  }, 240_000);
});
