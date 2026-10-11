import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, catalogApiUrl, orderServiceUrl } from "./http.ts";
import { seedProducts } from "./seed.ts";
import { cartWith, checkout, newCheckoutKey } from "./shopping.ts";
import { compose, logLinesWith as logLinesOf } from "./stack.ts";
import { tenants } from "./tenants.ts";

const logLinesWith = (correlationId: string, service = "catalog-cart-api") => logLinesOf(service, correlationId);


describe("catalog-cart API logs", () => {
  it("writes JSON request logs carrying service, environment, severity, and the caller's correlation ID (x-request-id)", async () => {
    const correlationId = `test-${randomUUID()}`;
    await api(`${catalogApiUrl}/products`, { headers: { "x-request-id": correlationId } });

    await expect
      .poll(() => logLinesWith(correlationId)[0], { timeout: 5_000 })
      .toMatchObject({ service: "catalog-cart-api", environment: "dev", severity: "info", requestId: correlationId });
  });

  it("names the request's tenant on every line of its tenant work", async () => {
    const correlationId = `test-${randomUUID()}`;
    await api(`${catalogApiUrl}/products`, { headers: { "x-request-id": correlationId } }, tenants.meadow);

    await expect.poll(() => logLinesWith(correlationId).at(-1), { timeout: 5_000 }).toMatchObject({
      tenantId: tenants.meadow.id,
      message: "request completed",
    });
  });

  it("logs the route template, never the token or ids in the raw URL", async () => {
    const correlationId = `test-${randomUUID()}`;
    const created = await api(`${catalogApiUrl}/carts`, { method: "POST" });
    const { id: cartToken } = (await created.json()) as { id: string };
    await api(`${catalogApiUrl}/carts/${cartToken}`, { headers: { "x-request-id": correlationId } });

    await expect
      .poll(() => logLinesWith(correlationId)[0], { timeout: 5_000 })
      .toMatchObject({ req: { method: "GET", route: "/carts/:id" } });
    expect(JSON.stringify(logLinesWith(correlationId))).not.toContain(cartToken);
  });

  it("never logs an Order token, whether returned by Checkout or presented to read an Order", async () => {
    const correlationId = `test-${randomUUID()}`;
    const cart = await cartWith({ [seedProducts.notebookSet]: 1 });
    const { body } = await checkout({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" });
    await api(`${orderServiceUrl}/orders/${body.orderId}`, {
      headers: { "x-request-id": correlationId, "x-order-token": body.orderToken },
    });

    await expect
      .poll(() => logLinesWith(correlationId, "order-service")[0], { timeout: 5_000 })
      .toMatchObject({ service: "order-service", req: { route: "/orders/:id" } });
    const recent = compose("logs", "--no-log-prefix", "--since", "2m", "order-service");
    expect(recent).not.toContain(body.orderToken);
  });
});
