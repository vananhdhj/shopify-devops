import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdminUsage } from "@shop/contracts";
import { planLimits, type TenantContext } from "@shop/tenancy";
import { adminToken } from "./admin.ts";
import { Browser } from "./browser.ts";
import { platformQuery } from "./db.ts";
import { api, catalogApiUrl } from "./http.ts";
import { baseDomain, routerPort, viaRouter } from "./router.ts";

const json = { "content-type": "application/json" };
const add = (shop: TenantContext, name: string) =>
  api(
    `${catalogApiUrl}/admin/products`,
    { method: "POST", headers: { ...json, "x-admin-token": adminToken() }, body: JSON.stringify({ name, priceMinor: 100, stock: 1 }) },
    shop,
  );
const usageOf = async (shop: TenantContext) =>
  (await (await api(`${catalogApiUrl}/admin/usage`, { headers: { "x-admin-token": adminToken() } }, shop)).json()) as AdminUsage;

/** A real starter shop (signed up, ACTIVE), so its Merchant can sign in through the edge. */
async function signedUpShop(password: string): Promise<TenantContext> {
  const handle = `pq-${randomUUID().slice(0, 8)}`;
  const res = await viaRouter(`${baseDomain}:${routerPort}`, "/signups", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name: "Quota Goods", password, plan: "starter" }),
  });
  const id = (JSON.parse(res.body) as { tenantId: string }).tenantId;
  await expect
    .poll(async () => (await platformQuery<{ status: string }>("SELECT status FROM platform.tenants WHERE id = $1", [id]))[0]?.status, {
      timeout: 30_000,
    })
    .toBe("ACTIVE");
  return { id, handle, name: "Quota Goods", credentialVersion: 1, plan: "starter" };
}

describe("the product quota", () => {
  it("refuses a starter shop's product past its plan's limit, and its Merchant sees why", async () => {
    const password = `pw-${randomUUID()}`;
    const shop = await signedUpShop(password);
    const limit = planLimits.starter.products;
    for (let i = 0; i < limit; i += 20) {
      const answers = await Promise.all(Array.from({ length: Math.min(20, limit - i) }, (_, j) => add(shop, `Item ${i + j}`)));
      expect(answers.every((answer) => answer.status === 201)).toBe(true);
    }
    const refused = await add(shop, "One too many");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "product_quota" });
    expect(await usageOf(shop)).toEqual({ plan: "starter", products: limit, productLimit: limit, requestsPerSecond: 10, burst: 30 });

    // The Merchant's admin shows the use, and the add form explains the refusal.
    const merchant = new Browser(shop.handle);
    await expect
      .poll(async () => (await merchant.submit("/admin/session", { password })).headers.get("location"), { timeout: 15_000 })
      .toBe("/admin");
    // React separates the page's text nodes with empty comments: read the text as a browser would.
    const text = async (path: string) => (await merchant.html(path)).replaceAll("<!-- -->", "");
    expect(await text("/admin")).toContain(`${limit} of ${limit} products`);
    const added = await merchant.submit("/admin/products", { name: "Still too many", priceMinor: "100", stock: "1" });
    expect(added.headers.get("location")).toBe("/admin/products/new?error=quota");
    expect(await text("/admin/products/new?error=quota")).toContain(`Your plan allows ${limit} products, and this shop has ${limit}.`);
  }, 120_000);

  it("lets exactly one of several concurrent adds take the last place", async () => {
    const shop: TenantContext = { id: randomUUID(), handle: `pq-${randomUUID().slice(0, 8)}`, name: "Race Goods", credentialVersion: 1, plan: "starter" };
    const limit = planLimits.starter.products;
    for (let i = 0; i < limit - 1; i += 33) {
      await Promise.all(Array.from({ length: Math.min(33, limit - 1 - i) }, (_, j) => add(shop, `Item ${i + j}`)));
    }
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => add(shop, `Last ${i}`)));
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await usageOf(shop)).products).toBe(limit);
  }, 120_000);
});
