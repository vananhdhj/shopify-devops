import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderServiceUrl, waitForOk } from "./http.ts";
import { seedProducts } from "./seed.ts";
import { cartWith, newCheckoutKey } from "./shopping.ts";
import { compose, stopContainer } from "./stack.ts";

// The bad-release drill's fault: an order-service replica started with the flag on, beside the
// stack's own order-service, which keeps it off.
describe("Checkout fault flag", () => {
  const faultyName = "shopify-devops-order-faulty";
  const faultyUrl = "http://127.0.0.1:4012";

  beforeAll(async () => {
    compose("run", "--detach", "--rm", "--no-deps", "--name", faultyName,
      "--env", "FAULT_CHECKOUT_ERRORS=true", "--publish", "127.0.0.1:4012:4002", "order-service");
    await waitForOk(`${faultyUrl}/health/ready`);
  });

  afterAll(() => {
    stopContainer(faultyName);
  });

  const checkoutAt = async (baseUrl: string) => {
    const cart = await cartWith({ [seedProducts.canvasTote]: 1 });
    const res = await fetch(`${baseUrl}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cartToken: cart.id, checkoutKey: newCheckoutKey(), paymentScenario: "approve" }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string; message?: string } };
  };

  it("answers every Checkout with 500 when on, while the replica stays ready", async () => {
    const faulty = await checkoutAt(faultyUrl);
    expect(faulty.status).toBe(500);
    expect(faulty.body.error).toBe("internal_error");

    expect((await fetch(`${faultyUrl}/health/ready`)).status).toBe(200);
    expect((await checkoutAt(orderServiceUrl)).status).toBe(202);
  });

  it("counts the failures as 5xx on the Checkout route, which the server-error alert watches", async () => {
    await checkoutAt(faultyUrl);
    const metrics = await (await fetch(`${faultyUrl}/metrics`)).text();
    expect(metrics).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/checkout"[^}]*status_code="500"[^}]*\} [1-9]/,
    );
  });
});
