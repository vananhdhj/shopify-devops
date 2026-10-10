import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { seedProducts } from "./seed.ts";

function checkoutKeyIn(html: string): string {
  const match = html.match(/name="checkoutKey" value="([^"]+)"/);
  if (!match) throw new Error("checkout form has no checkoutKey");
  return match[1]!;
}

describe("storefront checkout", () => {
  it("checks out the Cart into a Pending order page, then starts a fresh Cart", async () => {
    const browser = new Browser();
    await browser.submit("/cart/items", { productId: seedProducts.notebookSet, action: "add" });

    const form = await browser.html("/checkout");
    expect(form).toContain("Notebook Set");
    for (const scenario of ["approve", "decline", "slow"]) expect(form).toContain(`value="${scenario}"`);

    const res = await browser.submit("/orders", { checkoutKey: checkoutKeyIn(form), paymentScenario: "approve" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/orders\/[0-9a-f-]{36}\?token=[\w-]+$/);
    expect(res.headers.get("set-cookie")).toMatch(/cart=;.*Max-Age=0/i);

    const orderPage = await browser.html(res.headers.get("location")!);
    // The worker may settle the Order before the page loads; either state is a correct Order page.
    expect(orderPage).toMatch(/Status: (<!-- -->)?(Pending|Confirmed)/);
    expect(orderPage).toContain("Notebook Set");
    expect(orderPage).toContain("$12.00");

    expect(await browser.html("/cart")).toContain("Your cart is empty");
  });

  it("lands a double-submitted checkout form on the same Order", async () => {
    const browser = new Browser();
    await browser.submit("/cart/items", { productId: seedProducts.notebookSet, action: "add" });
    const fields = { checkoutKey: checkoutKeyIn(await browser.html("/checkout")), paymentScenario: "approve" };
    const cookieAtSubmit = browser.cookie;

    const first = await browser.submit("/orders", fields);
    browser.useCookie(cookieAtSubmit);
    const second = await browser.submit("/orders", fields);

    expect(second.headers.get("location")).toBe(first.headers.get("location"));
  });

  it("refuses to show an Order page without its Order token", async () => {
    const browser = new Browser();
    await browser.submit("/cart/items", { productId: seedProducts.notebookSet, action: "add" });
    const res = await browser.submit("/orders", {
      checkoutKey: checkoutKeyIn(await browser.html("/checkout")),
      paymentScenario: "approve",
    });
    const orderPath = res.headers.get("location")!.split("?")[0]!;

    expect((await browser.get(orderPath)).status).toBe(404);
    expect((await browser.get(`${orderPath}?token=wrong`)).status).toBe(404);
  });

  it("sends a Guest buyer with an empty Cart back to the Cart page", async () => {
    const res = await new Browser().get("/checkout");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(/\/cart$/);
  });
});
