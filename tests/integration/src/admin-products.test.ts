import { describe, expect, it } from "vitest";
import type { Product, ProductList } from "@shop/contracts";
import { adminAddProduct } from "./admin.ts";
import { catalogApiUrl, getJson } from "./http.ts";

const uniqueName = (label: string) => `${label} ${Date.now()}-${Math.round(Math.random() * 1e6)}`;

describe("admin products (catalog)", () => {
  it("refuses to add a product without the admin service token", async () => {
    const product = { name: uniqueName("Unauthorised Vase"), priceMinor: 1000, stock: 1 };
    expect((await adminAddProduct(product, null)).status).toBe(401);
    expect((await adminAddProduct(product, "wrong-token")).status).toBe(401);

    const list = await getJson<ProductList>(`${catalogApiUrl}/products`);
    expect(list.body.products.map((p) => p.name)).not.toContain(product.name);
  });

  it("adds a product that the listing and detail then serve", async () => {
    const name = uniqueName("Stoneware Bowl");
    const added = await adminAddProduct({ name, description: "Wheel-thrown.", priceMinor: 2750, stock: 9 });
    expect(added.status).toBe(201);

    const detail = await getJson<Product>(`${catalogApiUrl}/products/${added.body.id}`);
    expect(detail.body).toEqual({
      id: added.body.id,
      name,
      description: "Wheel-thrown.",
      priceMinor: 2750,
      currency: "USD",
      stock: 9,
    });
    const list = await getJson<ProductList>(`${catalogApiUrl}/products`);
    expect(list.body.products).toContainEqual(detail.body);
  });

  it.each([
    ["a missing name", { priceMinor: 100, stock: 1 }],
    ["an empty name", { name: "", priceMinor: 100, stock: 1 }],
    ["a negative price", { name: "x", priceMinor: -1, stock: 1 }],
    ["a fractional price", { name: "x", priceMinor: 10.5, stock: 1 }],
    ["negative Stock", { name: "x", priceMinor: 100, stock: -1 }],
  ])("refuses %s with 400", async (_label, product) => {
    expect(await adminAddProduct(product)).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });
});
