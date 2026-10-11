import { describe, expect, it } from "vitest";
import { signTenantContext, tenantContextHeader } from "@shop/tenancy";
import type { AdminOrderList, Cart, Product, ProductList } from "@shop/contracts";
import { adminToken } from "./admin.ts";
import { query } from "./db.ts";
import { api, catalogApiUrl, orderServiceUrl } from "./http.ts";
import { inventoryEffect, stockOf } from "./inventory.ts";
import { meadowProducts, seedProducts } from "./seed.ts";
import { cartWith, checkoutOf, newCheckoutKey, settled } from "./shopping.ts";
import { secret } from "./secrets.ts";
import { tenants } from "./tenants.ts";

const { harbor, meadow } = tenants;

/** A request as Meadow Supply, aimed at Harbor Goods' data. */
const asMeadow = (url: string, init: RequestInit = {}) => api(url, init, meadow);

const adminHeaders = () => ({ "content-type": "application/json", "x-admin-token": adminToken() });

describe("tenant isolation through the APIs", () => {
  it("shows each shop only its own products", async () => {
    const harborList = (await (await api(`${catalogApiUrl}/products`)).json()) as ProductList;
    const meadowList = (await (await asMeadow(`${catalogApiUrl}/products`)).json()) as ProductList;

    const harborIds = harborList.products.map((product) => product.id);
    const meadowIds = meadowList.products.map((product) => product.id);
    expect(harborIds).toContain(seedProducts.lastLantern);
    expect(harborIds).not.toContain(meadowProducts.heirloomSundial);
    expect(meadowIds).toContain(meadowProducts.heirloomSundial);
    expect(meadowIds).not.toContain(seedProducts.lastLantern);
  });

  it("does not find another shop's product", async () => {
    expect((await asMeadow(`${catalogApiUrl}/products/${seedProducts.lastLantern}`)).status).toBe(404);
  });

  it("does not find, change, or check out another shop's Cart", async () => {
    const cart = await cartWith({ [seedProducts.enamelMug]: 1 });

    expect((await asMeadow(`${catalogApiUrl}/carts/${cart.id}`)).status).toBe(404);
    const update = await asMeadow(`${catalogApiUrl}/carts/${cart.id}/items/${meadowProducts.gardenTwine}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 3 }),
    });
    expect(update.status).toBe(404);

    const checkout = await asMeadow(`${orderServiceUrl}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" }),
    });
    expect(checkout.status).toBe(404);
    expect(await checkout.json()).toMatchObject({ error: "cart_not_found" });

    // Harbor's Cart is untouched: still one Enamel Mug, still orderable by Harbor.
    const own = (await (await api(`${catalogApiUrl}/carts/${cart.id}`)).json()) as Cart;
    expect(own.items).toEqual([expect.objectContaining({ productId: seedProducts.enamelMug, quantity: 1 })]);
  });

  it("refuses a Cart line naming another shop's product", async () => {
    const cart = await cartWith({});
    const res = await api(`${catalogApiUrl}/carts/${cart.id}/items/${meadowProducts.gardenTwine}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "product_not_found" });
  });

  it("does not show another shop's Order, even with that Order's valid token", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");

    const read = await asMeadow(`${orderServiceUrl}/orders/${orderId}`, { headers: { "x-order-token": orderToken } });
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error: "order_not_found" });
  });

  it("keeps another shop's Orders out of the Merchant's list and out of fulfillment", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    expect((await settled(orderId, orderToken)).status).toBe("CONFIRMED");

    const list = (await (await asMeadow(`${orderServiceUrl}/admin/orders`, { headers: adminHeaders() })).json()) as AdminOrderList;
    expect(list.orders.map((order) => order.id)).not.toContain(orderId);

    const fulfill = await asMeadow(`${orderServiceUrl}/admin/orders/${orderId}/status`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ status: "FULFILLED" }),
    });
    expect(fulfill.status).toBe(404);
    const [row] = await query<{ status: string }>("SELECT status FROM orders.orders WHERE id = $1", [orderId]);
    expect(row?.status).toBe("CONFIRMED");
  });

  it("adds a Merchant's product to their own shop only", async () => {
    const name = `Meadow Only ${Date.now()}`;
    const added = await asMeadow(`${catalogApiUrl}/admin/products`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name, priceMinor: 500, stock: 3 }),
    });
    expect(added.status).toBe(201);
    const product = (await added.json()) as Product;

    expect((await api(`${catalogApiUrl}/products/${product.id}`)).status).toBe(404);
    const [row] = await query<{ tenant_id: string }>("SELECT tenant_id FROM catalog.products WHERE id = $1", [product.id]);
    expect(row?.tenant_id).toBe(meadow.id);
  });

  it("applies an Inventory effect only to the named tenant's Stock", async () => {
    const before = await stockOf(seedProducts.canvasTote);
    // Meadow Supply's deduction naming Harbor Goods' product finds no such product to take from.
    const res = await inventoryEffect({
      tenantId: meadow.id,
      orderId: crypto.randomUUID(),
      action: "deduct",
      items: [{ productId: seedProducts.canvasTote, quantity: 1 }],
    });
    expect(res.body.outcome).toBe("insufficient_stock");
    expect(await stockOf(seedProducts.canvasTote)).toBe(before);
  });
});

describe("tenant context", () => {
  const secretValue = () => secret("TENANT_CONTEXT_SECRET");

  const contexts = (): [string, string | undefined][] => {
    const valid = signTenantContext(harbor, secretValue());
    const [payload, signature] = valid.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...meadow, iat: Math.floor(Date.now() / 1000) })).toString("base64url");
    return [
      ["missing", undefined],
      ["malformed", "not-a-context"],
      ["tampered (payload swapped, signature kept)", `${forgedPayload}.${signature}`],
      ["signed with another secret", signTenantContext(harbor, "not-the-cell-secret")],
      ["expired", signTenantContext(harbor, secretValue(), Date.now() - 120_000)],
      ["issued in the future", signTenantContext(harbor, secretValue(), Date.now() + 60_000)],
      ["truncated signature", `${payload}.${signature!.slice(0, -2)}`],
    ];
  };

  it.each([
    ["catalog-cart API", `${catalogApiUrl}/products`],
    ["order service", `${orderServiceUrl}/orders/00000000-0000-4000-8000-000000000000`],
  ])("the %s refuses every request without a valid one", async (_label, url) => {
    for (const [label, context] of contexts()) {
      const res = await fetch(url, { headers: context ? { [tenantContextHeader]: context } : {} });
      expect.soft(res.status, label).toBe(401);
      expect.soft(await res.json(), label).toMatchObject({ error: "tenant_context_required" });
    }
  });

  it("the storefront serves no shop to a request that did not come through the router", async () => {
    const res = await fetch("http://127.0.0.1:3000/", {
      headers: { [tenantContextHeader]: signTenantContext(harbor, "not-the-cell-secret") },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("No shop at this address.\n");
  });

  it("leaves probes and scrapes outside any tenant", async () => {
    for (const url of [`${catalogApiUrl}/health/ready`, `${orderServiceUrl}/health/ready`, `${catalogApiUrl}/metrics`]) {
      expect.soft((await fetch(url)).status, url).toBe(200);
    }
  });
});
