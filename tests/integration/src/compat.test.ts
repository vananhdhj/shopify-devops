import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { baseDomain, routerPort, viaRouter } from "./router.ts";
import { secret } from "./secrets.ts";

/**
 * A shop's whole life through the edge, using only what every release since Phase 3 can do. CI's
 * `compat` job runs this file against the previous release's cell images (the last wave's pins on
 * main) with this change's migrations, control plane, and edge (ADR-0021): while a release moves
 * through the waves, the later cells still run the previous images on the new schema. It runs in
 * the normal suite too.
 */
const platformHost = `${baseDomain}:${routerPort}`;

describe("a shop's life across one version of skew", () => {
  it("signs up, sells as a Merchant to a guest, and is deleted", async () => {
    const handle = `compat-${randomUUID().slice(0, 8)}`;
    const password = `pw-${randomUUID()}`;
    const res = await viaRouter(platformHost, "/signups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name: "Compat Goods", password, plan: "starter" }),
    });
    expect(res.status, res.body).toBe(202);
    const tenantId = (JSON.parse(res.body) as { tenantId: string }).tenantId;
    const status = async () => (await platformQuery<{ status: string }>("SELECT status FROM platform.tenants WHERE id = $1", [tenantId]))[0]?.status;
    await expect.poll(status, { timeout: 30_000, interval: 500 }).toBe("ACTIVE");

    // The Merchant signs in (once the edge has picked the shop up) and adds a product.
    const merchant = new Browser(handle);
    await expect
      .poll(async () => (await merchant.submit("/admin/session", { password })).headers.get("location"), { timeout: 15_000 })
      .toBe("/admin");
    expect((await merchant.submit("/admin/products", { name: "Skew Lamp", priceMinor: "2500", stock: "4" })).status).toBe(303);

    // A guest buys it; the Order is settled by the cell's worker.
    const guest = new Browser(handle);
    const home = await guest.html("/");
    expect(home).toContain("Skew Lamp");
    const productId = /name="productId" value="([0-9a-f-]{36})"/.exec(home)?.[1];
    expect(productId).toBeDefined();
    await guest.submit("/cart/items", { productId: productId!, action: "add" });
    const checkoutKey = /name="checkoutKey" value="([^"]+)"/.exec(await guest.html("/checkout"))?.[1];
    expect(checkoutKey).toBeDefined();
    const placed = await guest.submit("/orders", { checkoutKey: checkoutKey!, paymentScenario: "approve" });
    expect(placed.status).toBe(303);
    const orderPage = placed.headers.get("location")!;
    await expect
      .poll(async () => /Status: (?:<!-- -->)?([A-Za-z]+)/.exec(await guest.html(orderPage))?.[1], { timeout: 30_000, interval: 500 })
      .toBe("Confirmed");

    // The platform operator deletes it; the control plane purges it from the cell.
    const deleted = await fetch(`${platformInternalUrl}/operator/tenants/${handle}/delete`, {
      method: "POST",
      headers: { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") },
    });
    expect(deleted.status).toBe(200);
    await expect.poll(status, { timeout: 60_000, interval: 500 }).toBe("DELETED");
  }, 150_000);
});
