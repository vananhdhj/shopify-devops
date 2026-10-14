import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { cellQuery } from "./db.ts";
import { adminToken } from "./admin.ts";
import { api, catalogApiUrl } from "./http.ts";
import { seedProducts } from "./seed.ts";
import { type Shop, deleteShop, password, starterShop } from "./shops.ts";
import { tenants } from "./tenants.ts";

/**
 * A Merchant deletes a product from their admin (Phase 6: the destructive action a restore
 * undoes). A fresh starter shop, so the seeded catalogs other tests rely on stay whole.
 */
describe("a Merchant deleting a product", () => {
  let shop: Shop;
  let products: string[];
  const merchant = () => new Browser(shop.handle);

  beforeAll(async () => {
    ({ shop, products } = await starterShop("dp", ["Delete Kettle", "Keep Teapot"]));
  }, 120_000);

  afterAll(async () => {
    if (shop) await deleteShop(shop);
  }, 120_000);

  it("lists the catalog in the admin, and deletes a product from it and from every Cart", async () => {
    const buyer = new Browser(shop.handle);
    expect((await buyer.submit("/cart/items", { productId: products[0]!, action: "add" })).status).toBe(303);
    const admin = merchant();
    expect((await admin.submit("/admin/session", { password })).headers.get("location")).toBe("/admin");
    const page = await admin.html("/admin");
    expect(page).toContain("Delete Kettle");
    expect(page).toContain(`/admin/products/${products[0]}/delete`);

    const deleted = await admin.submit(`/admin/products/${products[0]}/delete`, {});
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("location")).toBe("/admin?notice=product-deleted");
    expect(await admin.html("/admin?notice=product-deleted")).toContain("Product deleted.");

    expect(await buyer.html("/")).not.toContain("Delete Kettle");
    expect(await buyer.html("/")).toContain("Keep Teapot");
    expect(await buyer.html("/cart")).not.toContain("Delete Kettle");
    expect((await cellQuery("pool-1", "SELECT 1 FROM catalog.products WHERE id = $1", [products[0]])).length).toBe(0);

    // Again: there is nothing left to delete.
    expect((await admin.submit(`/admin/products/${products[0]}/delete`, {})).headers.get("location")).toBe("/admin?notice=product-not-deleted");
  });

  it("deletes only the shop's own products: another shop's id is not found, and stays", async () => {
    const res = await api(`${catalogApiUrl}/admin/products/${seedProducts.canvasTote}`, { method: "DELETE", headers: { "x-admin-token": adminToken() } }, tenants.meadow);
    expect(res.status).toBe(404);
    expect((await cellQuery("pool-1", "SELECT 1 FROM catalog.products WHERE id = $1", [seedProducts.canvasTote])).length).toBe(1);
  });

  it("refuses a visitor who is not the shop's Merchant", async () => {
    const res = await new Browser(shop.handle).submit(`/admin/products/${products[1]}/delete`, {});
    expect(res.headers.get("location")).toBe("/admin/login");
    expect((await cellQuery("pool-1", "SELECT 1 FROM catalog.products WHERE id = $1", [products[1]])).length).toBe(1);
  });
});
