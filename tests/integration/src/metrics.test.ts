import { describe, expect, it } from "vitest";
import { catalogApiUrl } from "./http.ts";
import { seedProducts } from "./seed.ts";

describe("catalog-cart API metrics", () => {
  it("records request durations by route template, never by raw id", async () => {
    const productId = seedProducts.enamelMug;
    await fetch(`${catalogApiUrl}/products/${productId}`);

    const res = await fetch(`${catalogApiUrl}/metrics`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/products\/:id"[^}]*status_code="200"[^}]*\} [1-9]/,
    );
    expect(body).not.toContain(productId);
  });
});
