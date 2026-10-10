import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cart, Product } from "@shop/contracts";
import { catalogApiUrl, getJson, waitForOk } from "./http.ts";
import { compose, stopContainer } from "./stack.ts";
import { seedProducts, unknownProductId } from "./seed.ts";

async function createCart(): Promise<{ status: number; cart: Cart }> {
  const res = await fetch(`${catalogApiUrl}/carts`, { method: "POST" });
  return { status: res.status, cart: (await res.json()) as Cart };
}

async function getCart(id: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${catalogApiUrl}/carts/${id}`);
  return { status: res.status, body: await res.json() };
}

async function setQuantity(
  cartId: string,
  productId: string,
  quantity: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${catalogApiUrl}/carts/${cartId}/items/${productId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quantity }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("cart", () => {
  it("creates an empty Cart that can be read back by its token", async () => {
    const created = await createCart();
    expect(created.status).toBe(201);
    expect(created.cart).toEqual({ id: expect.any(String), items: [], subtotalMinor: 0, currency: "USD" });

    const read = await getCart(created.cart.id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.cart);
  });

  it("sets a line's quantity at the current server-owned price, replacing it on repeat and removing it at zero", async () => {
    const { cart } = await createCart();

    const set = await setQuantity(cart.id, seedProducts.lastLantern, 2);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      id: cart.id,
      items: [
        { productId: seedProducts.lastLantern, name: "Last Lantern", priceMinor: 9900, quantity: 2, lineTotalMinor: 19800 },
      ],
      subtotalMinor: 19800,
      currency: "USD",
    });

    const replaced = await setQuantity(cart.id, seedProducts.lastLantern, 3);
    expect(replaced.body).toMatchObject({ items: [{ quantity: 3, lineTotalMinor: 29700 }], subtotalMinor: 29700 });

    const removed = await setQuantity(cart.id, seedProducts.lastLantern, 0);
    expect(removed.body).toMatchObject({ items: [], subtotalMinor: 0 });

    expect((await getCart(cart.id)).body).toEqual(removed.body);
  });

  it("answers 404 with a reason for an unknown or malformed cart token, or an unknown product", async () => {
    const { cart } = await createCart();
    const unknownCartId = "00000000-0000-4000-8000-00000000abcd";

    expect(await getCart(unknownCartId)).toMatchObject({ status: 404, body: { error: "cart_not_found" } });
    expect(await getCart("not-a-token")).toMatchObject({ status: 404, body: { error: "cart_not_found" } });
    expect(await setQuantity(unknownCartId, seedProducts.lastLantern, 1)).toMatchObject({
      status: 404,
      body: { error: "cart_not_found" },
    });
    expect(await setQuantity(cart.id, unknownProductId, 1)).toMatchObject({
      status: 404,
      body: { error: "product_not_found" },
    });
    expect(await setQuantity(cart.id, "not-a-product", 1)).toMatchObject({
      status: 404,
      body: { error: "product_not_found" },
    });
  });

  it.each([
    ["a negative quantity", -1],
    ["a fractional quantity", 1.5],
    ["a quantity sent as a string", "2"],
    ["a missing quantity", undefined],
    ["a quantity above the per-line limit of 99", 100],
  ])("rejects %s with 400 and leaves the Cart unchanged", async (_label, quantity) => {
    const { cart } = await createCart();
    await setQuantity(cart.id, seedProducts.enamelMug, 1);

    const res = await setQuantity(cart.id, seedProducts.enamelMug, quantity);
    expect(res).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect((await getCart(cart.id)).body).toMatchObject({ items: [{ quantity: 1 }] });
  });

  it("never changes a product's Stock when items are added to a Cart", async () => {
    const stockOf = async (id: string) => (await getJson<Product>(`${catalogApiUrl}/products/${id}`)).body.stock;
    const before = await stockOf(seedProducts.enamelMug);

    const { cart } = await createCart();
    await setQuantity(cart.id, seedProducts.enamelMug, 5);

    expect(await stockOf(seedProducts.enamelMug)).toBe(before);
  });
});

describe("cart across API replicas", () => {
  const replicaName = "shopify-devops-catalog-replica";
  const replicaUrl = "http://127.0.0.1:4011";

  beforeAll(async () => {
    compose("run", "--detach", "--rm", "--no-deps", "--name", replicaName,
      "--publish", "127.0.0.1:4011:4001", "catalog-cart-api");
    await waitForOk(`${replicaUrl}/health/ready`);
  });

  afterAll(() => {
    stopContainer(replicaName);
  });

  it("reads a Cart created through one replica, with identical contents, through another", async () => {
    const { cart } = await createCart();
    const updated = await setQuantity(cart.id, seedProducts.lastLantern, 2);

    const fromReplica = await fetch(`${replicaUrl}/carts/${cart.id}`);
    expect(fromReplica.status).toBe(200);
    expect(await fromReplica.json()).toEqual(updated.body);
  });
});
