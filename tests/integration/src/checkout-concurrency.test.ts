import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Cart } from "@shop/contracts";
import { planLimits, type TenantContext } from "@shop/tenancy";
import { InFlight } from "../../../apps/order-service/src/in-flight.ts";
import { adminToken } from "./admin.ts";
import { api, catalogApiUrl, orderServiceUrl } from "./http.ts";
import { checkout, newCheckoutKey } from "./shopping.ts";
import { seedProducts } from "./seed.ts";

describe("Checkout slots per tenant (pure)", () => {
  it("lets a tenant take up to its limit, frees a slot on release, and keeps tenants apart", () => {
    const slots = new InFlight();
    for (let i = 0; i < 3; i++) expect(slots.tryTake("a", 3)).toBe(true);
    expect(slots.tryTake("a", 3)).toBe(false);
    expect(slots.tryTake("b", 3)).toBe(true);
    slots.release("a");
    expect(slots.tryTake("a", 3)).toBe(true);
    for (let i = 0; i < 3; i++) slots.release("a");
    expect(slots.taken("a")).toBe(0);
  });
});

/** A fresh starter shop with one product and `n` Carts holding it, through the catalog API. */
async function shopWithCarts(n: number): Promise<{ shop: TenantContext; carts: string[] }> {
  const shop: TenantContext = { id: randomUUID(), handle: `cc-${randomUUID().slice(0, 8)}`, name: "Busy Shop", credentialVersion: 1, plan: "starter" };
  const json = { "content-type": "application/json" };
  const product = (await (
    await api(`${catalogApiUrl}/admin/products`, {
      method: "POST",
      headers: { ...json, "x-admin-token": adminToken() },
      body: JSON.stringify({ name: "Flash Sale Mug", priceMinor: 500, stock: 1_000 }),
    }, shop)
  ).json()) as { id: string };
  const carts: string[] = [];
  for (let i = 0; i < n; i++) {
    const cart = (await (await api(`${catalogApiUrl}/carts`, { method: "POST" }, shop)).json()) as Cart;
    await api(`${catalogApiUrl}/carts/${cart.id}/items/${product.id}`, { method: "PUT", headers: json, body: JSON.stringify({ quantity: 1 }) }, shop);
    carts.push(cart.id);
  }
  return { shop, carts };
}

const checkoutAs = async (shop: TenantContext, cartToken: string) => {
  const res = await api(
    `${orderServiceUrl}/checkout`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartToken, checkoutKey: newCheckoutKey(), paymentScenario: "decline" }) },
    shop,
  );
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: (await res.json()) as { error?: string } };
};

describe("the Checkout cap", () => {
  it("answers a shop over its plan's Checkouts in flight with 429 checkout_busy, while another shop's Checkout goes through", async () => {
    const { shop, carts } = await shopWithCarts(24);
    // Harbor's Checkout runs in the middle of the burst (Harbor is exempt in Compose, but its
    // Checkout shares the order service and the database with the burst).
    const harborCart = (await (await api(`${catalogApiUrl}/carts`, { method: "POST" })).json()) as Cart;
    await api(`${catalogApiUrl}/carts/${harborCart.id}/items/${seedProducts.notebookSet}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });

    const [answers, harbor] = await Promise.all([
      Promise.all(carts.map((cart) => checkoutAs(shop, cart))),
      checkout({ cartToken: harborCart.id, checkoutKey: newCheckoutKey(), paymentScenario: "decline" }),
    ]);
    const busy = answers.filter((answer) => answer.status === 429);
    expect(answers.every((answer) => answer.status === 202 || answer.status === 429)).toBe(true);
    expect(busy.length).toBeGreaterThan(0);
    expect(answers.filter((answer) => answer.status === 202).length).toBeGreaterThanOrEqual(planLimits.starter.checkoutsInFlight);
    expect(busy[0]).toMatchObject({ retryAfter: "1", body: { error: "checkout_busy" } });
    expect(harbor.status).toBe(202);

    // Every slot was given back: the refused Carts check out one by one.
    for (const cart of carts.filter((_, i) => answers[i]!.status === 429).slice(0, 3)) {
      expect((await checkoutAs(shop, cart)).status).toBe(202);
    }
  }, 60_000);
});
