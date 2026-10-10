import { describe, expect, it } from "vitest";
import { storefrontUrl } from "./http.ts";
import { seedProducts, unknownProductId } from "./seed.ts";

/** A minimal browser: remembers the cart cookie and submits forms the way an HTML form does. */
class Browser {
  private cookie = "";

  async submit(path: string, fields: Record<string, string>): Promise<Response> {
    const res = await fetch(`${storefrontUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: this.cookie },
      body: new URLSearchParams(fields),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    return res;
  }

  async html(path: string): Promise<string> {
    return (await fetch(`${storefrontUrl}${path}`, { headers: { cookie: this.cookie } })).text();
  }

  /** Pretends the browser already holds a cookie, e.g. one naming a Cart that no longer exists. */
  useCookie(cookie: string): void {
    this.cookie = cookie;
  }

  get cartCookie(): string {
    return this.cookie;
  }
}

describe("storefront cart", () => {
  it("adds a product to a new Cart, remembers it across reloads, and adds again", async () => {
    const browser = new Browser();

    const added = await browser.submit("/cart/items", { productId: seedProducts.lastLantern, action: "add" });
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toMatch(/\/cart$/);
    expect(browser.cartCookie).toMatch(/^cart=[0-9a-f-]{36}$/);
    expect(added.headers.get("set-cookie")).toMatch(/HttpOnly/i);

    const firstView = await browser.html("/cart");
    expect(firstView).toContain("Last Lantern");
    expect(firstView).toContain('value="1"');
    expect(firstView).toContain("$99.00");

    expect(await browser.html("/cart")).toBe(firstView);

    await browser.submit("/cart/items", { productId: seedProducts.lastLantern, action: "add" });
    const secondView = await browser.html("/cart");
    expect(secondView).toContain('value="2"');
    expect(secondView).toContain("$198.00");
  });

  it("sets a line's quantity and removes it at zero", async () => {
    const browser = new Browser();
    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "add" });

    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "set", quantity: "4" });
    const updated = await browser.html("/cart");
    expect(updated).toContain('value="4"');
    expect(updated).toContain("$56.00");

    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "set", quantity: "0" });
    const emptied = await browser.html("/cart");
    expect(emptied).not.toContain("Enamel Mug");
    expect(emptied).toContain("Your cart is empty");
  });

  it("shows an empty Cart to a Guest buyer without one", async () => {
    expect(await new Browser().html("/cart")).toContain("Your cart is empty");
  });

  it("starts a fresh Cart when the cookie names a Cart that no longer exists", async () => {
    const browser = new Browser();
    const staleCookie = "cart=00000000-0000-4000-8000-00000000dead";
    browser.useCookie(staleCookie);

    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "add" });

    expect(browser.cartCookie).toMatch(/^cart=[0-9a-f-]{36}$/);
    expect(browser.cartCookie).not.toBe(staleCookie);
    expect(await browser.html("/cart")).toContain("Enamel Mug");
  });

  it("leaves a line unchanged when a quantity update arrives without a valid quantity", async () => {
    const browser = new Browser();
    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "add" });

    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "set" });
    await browser.submit("/cart/items", { productId: seedProducts.enamelMug, action: "set", quantity: "lots" });

    expect(await browser.html("/cart")).toContain('value="1"');
  });

  it("tells the Guest buyer when a product couldn't be added, without starting a Cart", async () => {
    const browser = new Browser();
    const res = await browser.submit("/cart/items", { productId: unknownProductId, action: "add" });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cart?error=not-added");
    expect(browser.cartCookie).toBe("");
    expect(await browser.html("/cart?error=not-added")).toContain("That product couldn&#x27;t be added");
  });

  it("refuses an unknown form action", async () => {
    const res = await new Browser().submit("/cart/items", { productId: seedProducts.enamelMug, action: "explode" });
    expect(res.status).toBe(400);
  });
});
