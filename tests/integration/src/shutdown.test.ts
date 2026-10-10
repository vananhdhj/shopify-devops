import { describe, expect, it } from "vitest";
import { catalogApiUrl, statusOf, waitUntilCatalogReady } from "./http.ts";
import { asIdentity } from "./db.ts";
import { inventoryEffect, newOrderId } from "./inventory.ts";
import { seedProducts } from "./seed.ts";
import { compose, restartService } from "./stack.ts";

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
      restartService("catalog-cart-api");
      await waitUntilCatalogReady();
    }
  }, 60_000);

  it("lets an in-flight request finish while refusing new ones during shutdown", async () => {
    try {
      await asIdentity("superuser", async (db) => {
        await db.query("BEGIN");
        // Hold a product row so an Inventory effect on it stays in flight.
        await db.query("SELECT 1 FROM catalog.products WHERE id = $1 FOR UPDATE", [seedProducts.oliveWoodBoard]);
        const inFlight = inventoryEffect({
          orderId: newOrderId(),
          action: "deduct",
          items: [{ productId: seedProducts.oliveWoodBoard, quantity: 1 }],
        });
        await new Promise((resolve) => setTimeout(resolve, 500));

        compose("kill", "--signal", "SIGTERM", "catalog-cart-api");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect([0, 503]).toContain(await statusOf(`${catalogApiUrl}/products`));

        await db.query("ROLLBACK");
        expect((await inFlight).status).toBe(200);
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(compose("ps", "--all", "--format", "{{.ExitCode}}", "catalog-cart-api").trim()).toBe("0");
    } finally {
      // The SIGTERM above returns immediately; wait for the exit before starting it again,
      // or `up` would see a container that is still running and do nothing.
      compose("stop", "--timeout", "10", "catalog-cart-api");
      restartService("catalog-cart-api");
      await waitUntilCatalogReady();
    }
  }, 60_000);
});
