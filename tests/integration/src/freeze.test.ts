import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { cellQuery, platformQuery } from "./db.ts";
import { api, catalogApiUrl, orderServiceUrl, waitFor } from "./http.ts";
import { secret } from "./secrets.ts";
import { meadowProducts, seedProducts } from "./seed.ts";
import { tenants } from "./tenants.ts";

/**
 * Phase 6's read-only freeze: Meadow Supply is set MOVING in the registry, as a move does, and the
 * edge serves it read-only. Meadow is unfrozen after, whatever happens.
 */
const meadow = tenants.meadow;
const frozenContext = { ...meadow, readOnly: true };

const setStatus = (status: string) => platformQuery("UPDATE platform.tenants SET status = $2 WHERE id = $1", [meadow.id, status]);

/** True once the edge's routing table (refreshed every 2 s) serves Meadow's form posts the given way. */
async function edgeServesMeadow(frozen: boolean): Promise<void> {
  await waitFor(
    async () => {
      const res = await new Browser("meadow").submit("/cart/items", { productId: meadowProducts.gardenTwine, action: "add" });
      return frozen ? res.status === 503 : res.status === 303;
    },
    `the edge serves Meadow ${frozen ? "frozen" : "writable"}`,
    15_000,
  );
}

function checkoutKeyIn(html: string): string {
  const match = html.match(/name="checkoutKey" value="([^"]+)"/);
  if (!match) throw new Error("checkout form has no checkoutKey");
  return match[1]!;
}

const orderStatus = async (orderId: string) =>
  (await cellQuery<{ status: string }>("pool-1", "SELECT status FROM orders.orders WHERE id = $1", [orderId]))[0]?.status;

describe("a shop frozen for a move", () => {
  const buyer = new Browser("meadow");
  let checkoutForm = "";
  let pendingOrderId = "";

  beforeAll(async () => {
    // A buyer with a Cart and a Checkout form open, and an Order whose payment is slow (3 s), so it
    // is still Pending when the freeze starts.
    expect((await buyer.submit("/cart/items", { productId: meadowProducts.handTrowel, action: "add" })).status).toBe(303);
    checkoutForm = await buyer.html("/checkout");
    const slow = new Browser("meadow");
    await slow.submit("/cart/items", { productId: meadowProducts.seedPacketTrio, action: "add" });
    const placed = await slow.submit("/orders", { checkoutKey: checkoutKeyIn(await slow.html("/checkout")), paymentScenario: "slow" });
    expect(placed.status).toBe(303);
    pendingOrderId = placed.headers.get("location")!.match(/^\/orders\/([0-9a-f-]{36})/)![1]!;

    await setStatus("MOVING");
    expect(await orderStatus(pendingOrderId)).toBe("PENDING");
    await edgeServesMeadow(true);
  }, 60_000);

  afterAll(async () => {
    await setStatus("ACTIVE");
  });

  it("settles a Pending Order while frozen", async () => {
    await expect.poll(() => orderStatus(pendingOrderId), { timeout: 20_000, interval: 250 }).toBe("CONFIRMED");
    expect((await platformQuery<{ status: string }>("SELECT status FROM platform.tenants WHERE id = $1", [meadow.id]))[0]?.status).toBe(
      "MOVING",
    );
  });

  it("keeps browsing: the home page, a product, the Cart, and the Checkout form", async () => {
    const home = await buyer.get("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Hand Trowel");
    expect((await buyer.get(`/products/${meadowProducts.wateringCan}`)).status).toBe(200);
    expect(await buyer.html("/cart")).toContain("Hand Trowel");
    expect((await buyer.get("/checkout")).status).toBe(200);
  });

  it("answers cart and Checkout with the updating page, keeping the Cart", async () => {
    for (const res of [
      await buyer.submit("/cart/items", { productId: meadowProducts.wateringCan, action: "add" }),
      await buyer.submit("/orders", { checkoutKey: checkoutKeyIn(checkoutForm), paymentScenario: "approve" }),
    ]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.text()).toContain("This shop is updating, try again in a moment");
    }
    const cart = await buyer.html("/cart");
    expect(cart).toContain("Hand Trowel");
    expect(cart).not.toContain("Watering Can");
  });

  it("lets the Merchant sign in and read the admin, and refuses their writes", async () => {
    const merchant = new Browser("meadow");
    const signIn = await merchant.submit("/admin/session", { password: secret("MERCHANT_PASSWORD_MEADOW") });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("location")).toBe("/admin");
    expect((await merchant.get("/admin")).status).toBe(200);
    const add = await merchant.submit("/admin/products", { name: `Frozen ${Date.now()}`, priceMinor: "100", stock: "1" });
    expect(add.status).toBe(503);
    expect(await add.text()).toContain("This shop is updating");
  });

  it("has the APIs refuse a read-only context's writes and answer its reads", async () => {
    const carts = await api(`${catalogApiUrl}/carts`, { method: "POST" }, frozenContext);
    expect(carts.status).toBe(503);
    expect(await carts.json()).toMatchObject({ error: "shop_updating" });
    const checkout = await api(
      `${orderServiceUrl}/checkout`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartToken: "x", checkoutKey: "y", paymentScenario: "approve" }) },
      frozenContext,
    );
    expect(checkout.status).toBe(503);
    expect((await api(`${catalogApiUrl}/products`, {}, frozenContext)).status).toBe(200);
  });

  it("leaves another shop in the cell writable", async () => {
    expect((await new Browser().submit("/cart/items", { productId: seedProducts.canvasTote, action: "add" })).status).toBe(303);
  });

  it("allows only ACTIVE out of a freeze", async () => {
    for (const status of ["SUSPENDED", "RESTORING", "DELETING", "PROVISIONING"]) {
      await expect(setStatus(status), status).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("takes writes again once unfrozen", async () => {
    await setStatus("ACTIVE");
    await edgeServesMeadow(false);
    expect((await buyer.submit("/cart/items", { productId: meadowProducts.wateringCan, action: "add" })).status).toBe(303);
    expect(await buyer.html("/cart")).toContain("Watering Can");
  });
});
