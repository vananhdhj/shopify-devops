import { describe, expect, it } from "vitest";
import { catalogApiUrl, statusOf, waitUntilCatalogReady } from "./http.ts";
import { compose } from "./stack.ts";

const live = `${catalogApiUrl}/health/live`;
const ready = `${catalogApiUrl}/health/ready`;

describe("catalog-cart API health", () => {
  it("is live and ready while its database is up", async () => {
    expect(await statusOf(live)).toBe(200);
    expect(await statusOf(ready)).toBe(200);
  });

  it("reports not ready, but stays live, while its database is down", async () => {
    compose("stop", "postgres");
    try {
      await expect.poll(() => statusOf(ready), { timeout: 15_000 }).toBe(503);
      expect(await statusOf(live)).toBe(200);
    } finally {
      compose("start", "postgres");
      await waitUntilCatalogReady();
    }
  });
});
