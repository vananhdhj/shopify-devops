import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { shopFetch } from "./router.ts";
import { seedProducts } from "./seed.ts";
import { compose, logLinesWith } from "./stack.ts";

describe("storefront logs", () => {
  it("writes a JSON line per request with the correlation ID, and forwards that ID to the APIs", async () => {
    const correlationId = `test-${randomUUID()}`;
    await shopFetch(`/products/${seedProducts.lastLantern}`, { headers: { "x-request-id": correlationId } });

    await expect
      .poll(() => logLinesWith("storefront", correlationId)[0], { timeout: 5_000 })
      .toMatchObject({
        service: "storefront",
        environment: "dev",
        severity: "info",
        requestId: correlationId,
        req: { method: "GET", path: `/products/${seedProducts.lastLantern}` },
      });
    await expect
      .poll(() => logLinesWith("catalog-cart-api", correlationId)[0], { timeout: 5_000 })
      .toMatchObject({ req: { route: "/products/:id" } });
  });

  it("never logs a query string, so Order tokens in Order links stay out of logs", async () => {
    const browser = new Browser();
    await browser.submit("/cart/items", { productId: seedProducts.notebookSet, action: "add" });
    const form = await browser.html("/checkout");
    const checkoutKey = form.match(/name="checkoutKey" value="([^"]+)"/)![1]!;
    const placed = await browser.submit("/orders", { checkoutKey, paymentScenario: "approve" });
    const orderLink = placed.headers.get("location")!;
    const token = new URL(orderLink, browser.origin).searchParams.get("token")!;

    const correlationId = `test-${randomUUID()}`;
    await shopFetch(orderLink, { headers: { "x-request-id": correlationId } });

    await expect
      .poll(() => logLinesWith("storefront", correlationId)[0], { timeout: 5_000 })
      .toMatchObject({ req: { path: orderLink.split("?")[0] } });
    expect(compose("logs", "--no-log-prefix", "--since", "2m", "storefront")).not.toContain(token);
  });
});
