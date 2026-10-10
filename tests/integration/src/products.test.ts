import { describe, expect, it } from "vitest";
import type { Product, ProductList } from "@shop/contracts";
import { catalogApiUrl, getJson } from "./http.ts";
import { unknownProductId } from "./seed.ts";

describe("product catalog", () => {
  it("serves the same product and server-owned price in listing and detail", async () => {
    const list = await getJson<ProductList>(`${catalogApiUrl}/products`);
    expect(list.status).toBe(200);

    // Expected values come from the seed data, not from the API.
    const lantern = list.body.products.find((p) => p.name === "Last Lantern");
    expect(lantern).toMatchObject({ priceMinor: 9900, currency: "USD", stock: 1 });

    const detail = await getJson<Product>(`${catalogApiUrl}/products/${lantern!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(lantern);
  });

  it.each([
    ["an unknown product id", unknownProductId],
    ["a malformed product id", "not-a-uuid"],
  ])("answers 404 for %s", async (_label, id) => {
    const res = await getJson<{ error: string }>(`${catalogApiUrl}/products/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });
});
