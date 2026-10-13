import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { limitClassOf, planLimits, signTenantContext, verifyTenantContext } from "@shop/tenancy";

// The tenant context carries the shop's limit class (Phase 5): pure functions, no stack needed.
const secret = "a-test-secret";
const shop = { id: "10000000-0000-4000-8000-000000000001", handle: "harbor", name: "Harbor Goods", credentialVersion: 3 };

describe("the plan in the tenant context", () => {
  it("round-trips every limit class", () => {
    for (const plan of ["starter", "plus", "internal"] as const) {
      expect(verifyTenantContext(signTenantContext({ ...shop, plan }, secret), secret)).toEqual({ ...shop, plan, readOnly: false });
    }
  });

  it("reads a context signed by an edge of an earlier release as starter", () => {
    const payload = Buffer.from(
      JSON.stringify({ id: shop.id, handle: shop.handle, name: shop.name, cv: 3, iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    const old = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
    expect(verifyTenantContext(old, secret)).toEqual({ ...shop, plan: "starter", readOnly: false });
  });

  it("refuses a context naming an unknown class", () => {
    const payload = Buffer.from(
      JSON.stringify({ id: shop.id, handle: shop.handle, name: shop.name, cv: 3, p: "unlimited", iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    expect(verifyTenantContext(`${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`, secret)).toBeUndefined();
  });

  it("carries the read-only flag of a frozen shop (Phase 6), and reads its absence as false", () => {
    const frozen = signTenantContext({ ...shop, plan: "starter", readOnly: true }, secret);
    expect(verifyTenantContext(frozen, secret)).toEqual({ ...shop, plan: "starter", readOnly: true });
    const open = signTenantContext({ ...shop, plan: "starter", readOnly: false }, secret);
    expect(JSON.parse(Buffer.from(open.split(".")[0]!, "base64url").toString("utf8"))).not.toHaveProperty("ro");
    const payload = Buffer.from(
      JSON.stringify({ id: shop.id, handle: shop.handle, name: shop.name, cv: 3, ro: "yes", iat: Math.floor(Date.now() / 1000) }),
    ).toString("base64url");
    expect(verifyTenantContext(`${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`, secret)).toBeUndefined();
  });

  it("maps a route to its class: internal first, then plus, otherwise starter", () => {
    expect(limitClassOf({ plan: "plus", internal: true })).toBe("internal");
    expect(limitClassOf({ plan: "plus", internal: false })).toBe("plus");
    expect(limitClassOf({ plan: "starter" })).toBe("starter");
    expect(limitClassOf({})).toBe("starter");
  });

  it("holds plus above starter on every limit, and never rate limits a synthetic shop", () => {
    for (const key of Object.keys(planLimits.starter) as (keyof typeof planLimits.starter)[]) {
      expect(planLimits.plus[key]).toBeGreaterThan(planLimits.starter[key]);
    }
    expect(planLimits.internal.requestsPerSecond).toBe(Number.POSITIVE_INFINITY);
  });
});
