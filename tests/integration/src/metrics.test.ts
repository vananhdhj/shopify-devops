import { describe, expect, it } from "vitest";
import { api, catalogApiUrl, orderServiceUrl } from "./http.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf } from "./shopping.ts";
import { tenants } from "./tenants.ts";

describe("catalog-cart API metrics", () => {
  it("records request durations by route template, never by raw id", async () => {
    const productId = seedProducts.enamelMug;
    await api(`${catalogApiUrl}/products/${productId}`);

    const res = await api(`${catalogApiUrl}/metrics`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/products\/:id"[^}]*status_code="200"[^}]*\} [1-9]/,
    );
    expect(body).not.toContain(productId);
  });

  it("reports the age of each shop's oldest Pending order from the order service, which outlives a stopped worker", async () => {
    // A slow payment keeps the Order Pending for 3 s.
    await checkoutOf({ [seedProducts.notebookSet]: 1 }, "slow");
    const body = await (await api(`${orderServiceUrl}/metrics`)).text();
    expect(body).toMatch(new RegExp(`^orders_oldest_pending_age_seconds\\{tenant_id="${tenants.harbor.id}"\\} [\\d.e+-]+$`, "m"));
  });

  it("serves the storefront's process metrics on its private metrics port", async () => {
    const res = await fetch("http://127.0.0.1:9464/metrics");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^process_cpu_user_seconds_total \d/m);
  });
});

