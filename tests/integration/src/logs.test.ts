import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogApiUrl } from "./http.ts";
import { compose } from "./stack.ts";

function logLinesWith(correlationId: string): Record<string, unknown>[] {
  return compose("logs", "--no-log-prefix", "--since", "2m", "catalog-cart-api")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.requestId === correlationId);
}

describe("catalog-cart API logs", () => {
  it("writes JSON request logs carrying service, environment, severity, and the caller's correlation ID (x-request-id)", async () => {
    const correlationId = `test-${randomUUID()}`;
    await fetch(`${catalogApiUrl}/products`, { headers: { "x-request-id": correlationId } });

    await expect
      .poll(() => logLinesWith(correlationId)[0], { timeout: 5_000 })
      .toMatchObject({ service: "catalog-cart-api", environment: "dev", severity: "info", requestId: correlationId });
  });

  it("logs the route template, never the token or ids in the raw URL", async () => {
    const correlationId = `test-${randomUUID()}`;
    const created = await fetch(`${catalogApiUrl}/carts`, { method: "POST" });
    const { id: cartToken } = (await created.json()) as { id: string };
    await fetch(`${catalogApiUrl}/carts/${cartToken}`, { headers: { "x-request-id": correlationId } });

    await expect
      .poll(() => logLinesWith(correlationId)[0], { timeout: 5_000 })
      .toMatchObject({ req: { method: "GET", route: "/carts/:id" } });
    expect(JSON.stringify(logLinesWith(correlationId))).not.toContain(cartToken);
  });
});
