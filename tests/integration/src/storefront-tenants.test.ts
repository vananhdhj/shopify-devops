import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { secret } from "./secrets.ts";
import { meadowProducts, seedProducts } from "./seed.ts";

async function signedIn(handle: string, passwordKey: string): Promise<Browser> {
  const browser = new Browser(handle);
  const res = await browser.submit("/admin/session", { password: secret(passwordKey) });
  if (res.status !== 303 || res.headers.get("location") !== "/admin") throw new Error(`sign-in at ${handle} failed`);
  return browser;
}

describe("two shops in one storefront", () => {
  it("shows each shop's own name and only its own products", async () => {
    const harbor = await new Browser("harbor").html("/");
    const meadow = await new Browser("meadow").html("/");

    expect(harbor).toContain("Harbor Goods");
    expect(harbor).toContain("Last Lantern");
    expect(harbor).not.toContain("Meadow Supply");
    expect(harbor).not.toContain("Heirloom Sundial");

    expect(meadow).toContain("Meadow Supply");
    expect(meadow).toContain("Heirloom Sundial");
    expect(meadow).not.toContain("Harbor Goods");
    expect(meadow).not.toContain("Last Lantern");
  });

  it("does not show another shop's product page", async () => {
    expect((await new Browser("meadow").get(`/products/${seedProducts.lastLantern}`)).status).toBe(404);
    expect((await new Browser("harbor").get(`/products/${meadowProducts.heirloomSundial}`)).status).toBe(404);
  });

  it("takes a Merchant's password only at their own shop", async () => {
    const atHarbor = await new Browser("harbor").submit("/admin/session", { password: secret("MERCHANT_PASSWORD_MEADOW") });
    expect(atHarbor.headers.get("location")).toBe("/admin/login?error=invalid");

    const meadowMerchant = await signedIn("meadow", "MERCHANT_PASSWORD_MEADOW");
    expect((await meadowMerchant.get("/admin")).status).toBe(200);
  });

  it("does not honour one shop's Merchant session at another shop's address", async () => {
    const harborMerchant = await signedIn("harbor", "MERCHANT_PASSWORD_HARBOR");
    expect((await harborMerchant.get("/admin")).status).toBe(200);

    const carried = new Browser("meadow");
    carried.useCookie(harborMerchant.cookie);
    const res = await carried.get("/admin");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/admin\/login$/);
  });

  it("shows nothing for one shop's Order link at another shop's address", async () => {
    const buyer = new Browser("harbor");
    await buyer.submit("/cart/items", { productId: seedProducts.notebookSet, action: "add" });
    const checkoutKey = (await buyer.html("/checkout")).match(/name="checkoutKey" value="([^"]+)"/)![1]!;
    const placed = await buyer.submit("/orders", { checkoutKey, paymentScenario: "approve" });
    const orderLink = placed.headers.get("location")!;

    expect((await buyer.get(orderLink)).status).toBe(200);
    expect((await new Browser("meadow").get(orderLink)).status).toBe(404);
  });
});
