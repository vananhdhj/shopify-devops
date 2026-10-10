import { describe, expect, it } from "vitest";
import { storefrontUrl } from "./http.ts";
import { seedProducts, unknownProductId } from "./seed.ts";

async function page(path: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${storefrontUrl}${path}`);
  return { status: res.status, html: await res.text() };
}

describe("storefront", () => {
  it("lists seeded products with their prices", async () => {
    const { status, html } = await page("/");
    expect(status).toBe(200);
    expect(html).toContain("Last Lantern");
    expect(html).toContain("$99.00");
    expect(html).toContain("Canvas Tote");
    expect(html).toContain("$18.00");
  });

  it("shows a product's detail page with price and availability", async () => {
    const { status, html } = await page(`/products/${seedProducts.lastLantern}`);
    expect(status).toBe(200);
    expect(html).toContain("Last Lantern");
    expect(html).toContain("Signed lantern; only one made.");
    expect(html).toContain("$99.00");
    expect(html).toContain("1 in stock");
  });

  it("answers 404 for an unknown product", async () => {
    const { status } = await page(`/products/${unknownProductId}`);
    expect(status).toBe(404);
  });

  it("renders on the server, never handing the browser the internal API address", async () => {
    const { html } = await page("/");
    expect(html).not.toContain("catalog-cart-api");
    expect(html).not.toContain(":4001");
  });

  it("offers add-to-cart on the listing as well as the product page", async () => {
    for (const path of ["/", `/products/${seedProducts.lastLantern}`]) {
      const { html } = await page(path);
      expect(html).toContain('action="/cart/items"');
      expect(html).toContain(`value="${seedProducts.lastLantern}"`);
    }
  });
});
