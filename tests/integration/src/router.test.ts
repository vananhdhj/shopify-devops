import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signTenantContext } from "@shop/tenancy";
import { seedProducts } from "./seed.ts";
import { secret } from "./secrets.ts";
import { logLinesWith } from "./stack.ts";
import { shopHost, viaRouter } from "./router.ts";
import { tenants } from "./tenants.ts";

const correlationId = () => `test-${randomUUID()}`;

describe("router", () => {
  it.each(Object.values(tenants))("routes $handle's address to the storefront with that shop's context", async (tenant) => {
    const requestId = correlationId();
    const res = await viaRouter(shopHost(tenant.handle), "/", { headers: { "x-request-id": requestId } });

    expect(res.status).toBe(200);
    await expect
      .poll(() => logLinesWith("storefront", requestId)[0], { timeout: 5_000 })
      .toMatchObject({ tenant: tenant.handle, req: { method: "GET", path: "/" } });
    await expect.poll(() => logLinesWith("router", requestId).at(-1), { timeout: 5_000 }).toMatchObject({
      tenant: tenant.handle,
      res: { statusCode: 200 },
    });
  });

  it("replaces a context sent by the client, even one that is validly signed for another shop", async () => {
    const requestId = correlationId();
    const forged = signTenantContext(tenants.meadow, secret("TENANT_CONTEXT_SECRET"));
    await viaRouter(shopHost("harbor"), "/", { headers: { "x-request-id": requestId, "x-tenant-context": forged } });

    await expect
      .poll(() => logLinesWith("storefront", requestId)[0], { timeout: 5_000 })
      .toMatchObject({ tenant: "harbor" });
  });

  it.each([
    ["an unknown handle", shopHost("nowhere")],
    ["a deeper subdomain", `www.${shopHost("harbor")}`],
    ["another domain", "harbor.example.com"],
  ])("answers %s with the same fixed 404, without reaching the storefront", async (_label, host) => {
    const requestId = correlationId();
    const res = await viaRouter(host, "/products", { headers: { "x-request-id": requestId } });

    expect(res.status).toBe(404);
    expect(res.body).toBe("No shop at this address.\n");
    await expect.poll(() => logLinesWith("router", requestId).at(-1), { timeout: 5_000 }).toMatchObject({
      res: { statusCode: 404 },
    });
    expect(logLinesWith("storefront", requestId)).toEqual([]);
  });

  it("sends the bare base domain to the control plane's signup pages, without a tenant context", async () => {
    const res = await viaRouter("shop.localhost:8000", "/", { headers: { "x-tenant-context": "forged" } });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Open a shop");
  });

  it("passes a form post through to the storefront unchanged", async () => {
    const host = shopHost("harbor");
    const added = await viaRouter(host, "/cart/items", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://${host}` },
      body: new URLSearchParams({ productId: seedProducts.enamelMug, action: "add" }).toString(),
    });
    expect(added.status).toBe(303);
    const cookie = String(added.headers["set-cookie"]).split(";")[0]!;

    const cart = await viaRouter(host, "/cart", { headers: { cookie } });
    expect(cart.body).toContain("Enamel Mug");
  });

  it("keeps health and metrics off the public port", async () => {
    // The router's own operational endpoints live on its private port; on the public port these
    // paths are just storefront paths, which the storefront does not serve.
    for (const path of ["/health/ready", "/metrics"]) {
      expect((await viaRouter(shopHost("harbor"), path)).body).not.toContain("http_request_duration_seconds");
    }
  });
});
