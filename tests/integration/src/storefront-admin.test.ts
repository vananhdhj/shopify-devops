import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { secret } from "./secrets.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, readOrder, settled } from "./shopping.ts";

async function signedInMerchant(): Promise<Browser> {
  const browser = new Browser();
  const res = await browser.submit("/admin/session", { password: secret("ADMIN_PASSWORD") });
  if (res.status !== 303 || res.headers.get("location") !== "/admin") throw new Error("sign-in failed");
  return browser;
}

describe("storefront admin", () => {
  it("sends a visitor without a Merchant session to sign-in, for pages and form posts alike", async () => {
    const guest = new Browser();
    for (const path of ["/admin", "/admin/products/new"]) {
      const res = await guest.get(path);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toMatch(/\/admin\/login$/);
    }

    const name = `Sneaky ${Date.now()}`;
    const post = await guest.submit("/admin/products", { name, priceMinor: "100", stock: "1" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/admin/login");
    expect(await guest.html("/")).not.toContain(name);

    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    await settled(orderId, orderToken);
    const fulfill = await guest.submit(`/admin/orders/${orderId}/fulfillment`, {});
    expect(fulfill.headers.get("location")).toBe("/admin/login");
    expect((await readOrder(orderId, orderToken)).body.status).toBe("CONFIRMED");
  });

  it("refuses sign-in and admin form posts sent from another site", async () => {
    const evil = "http://evil.example";
    const signIn = await new Browser().submit("/admin/session", { password: secret("ADMIN_PASSWORD") }, evil);
    expect(signIn.status).toBe(403);
    expect(signIn.headers.get("set-cookie")).toBeNull();

    const merchant = await signedInMerchant();
    const name = `Cross Site ${Date.now()}`;
    const post = await merchant.submit("/admin/products", { name, priceMinor: "100", stock: "1" }, evil);
    expect(post.status).toBe(403);
    expect(await merchant.html("/")).not.toContain(name);
  });

  it("refuses a wrong password without starting a session", async () => {
    const browser = new Browser();
    const res = await browser.submit("/admin/session", { password: "not-the-password" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login?error=invalid");
    expect(browser.cookie).toBe("");
  });

  it("signs the Merchant in with an httpOnly, strict, admin-scoped session", async () => {
    const browser = new Browser();
    const res = await browser.submit("/admin/session", { password: secret("ADMIN_PASSWORD") });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^merchant_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/admin/i);
    expect((await browser.get("/admin")).status).toBe(200);
  });

  it("rejects a tampered session cookie", async () => {
    const browser = await signedInMerchant();
    browser.useCookie(`${browser.cookie.slice(0, -2)}xx`);
    expect((await browser.get("/admin")).status).toBe(307);
  });

  it("lets the Merchant add a product that shoppers then see", async () => {
    const merchant = await signedInMerchant();
    const name = `Glazed Jug ${Date.now()}`;

    const res = await merchant.submit("/admin/products", { name, description: "Holds a litre.", priceMinor: "3100", stock: "4" });
    expect(res.status).toBe(303);

    const shop = await new Browser().html("/");
    expect(shop).toContain(name);
    expect(shop).toContain("$31.00");
  });

  it("lists Orders and fulfills a Confirmed one", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    await settled(orderId, orderToken);
    const merchant = await signedInMerchant();

    const list = await merchant.html("/admin");
    expect(list).toContain(orderId);
    expect(list).toContain(`action="/admin/orders/${orderId}/fulfillment"`);

    const res = await merchant.submit(`/admin/orders/${orderId}/fulfillment`, {});
    expect(res.status).toBe(303);
    expect((await readOrder(orderId, orderToken)).body.status).toBe("FULFILLED");
  });

  it("signs the Merchant out", async () => {
    const merchant = await signedInMerchant();
    const res = await merchant.submit("/admin/session/end", {});
    expect(res.headers.get("set-cookie")).toMatch(/merchant_session=;.*Max-Age=0/i);
    expect((await merchant.get("/admin")).status).toBe(307);
  });
});
