import { describe, expect, it } from "vitest";
import { waitUntilCatalogReady } from "./http.ts";
import { compose } from "./stack.ts";

describe("catalog-cart API shutdown", () => {
  it("exits cleanly and promptly on SIGTERM instead of being killed", async () => {
    try {
      const started = Date.now();
      compose("stop", "--timeout", "10", "catalog-cart-api");
      const elapsedMs = Date.now() - started;

      const exitCode = compose("ps", "--all", "--format", "{{.ExitCode}}", "catalog-cart-api").trim();
      expect(exitCode).toBe("0");
      expect(elapsedMs).toBeLessThan(8_000);
    } finally {
      // Restart only this container: `compose start` would re-run role bootstrap and
      // migrations first, which on a fresh stack can outlast the test's budget.
      compose("up", "--detach", "--no-deps", "--wait", "catalog-cart-api");
      await waitUntilCatalogReady();
    }
  }, 60_000);
});
