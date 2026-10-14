import "server-only";
import { headers } from "next/headers";
import { tenantContextHeader, type TenantContext, verifyTenantContext } from "@shop/tenancy";
import { requiredEnv } from "./env";

/**
 * The shop this request is for, from the router's signed tenant context. proxy.ts has already
 * refused requests without a valid one, so a page or handler always has a tenant.
 */
export function tenantFrom(requestHeaders: Headers): TenantContext {
  // The cell's current secret, and during a rotation (Phase 7) the next one as well.
  const secrets = [requiredEnv("TENANT_CONTEXT_SECRET"), process.env.TENANT_CONTEXT_SECRET_NEXT].filter((s): s is string => !!s);
  const tenant = verifyTenantContext(requestHeaders.get(tenantContextHeader), secrets);
  if (!tenant) throw new Error("request reached the storefront without a valid tenant context");
  return tenant;
}

/** The current request's shop, for pages and layouts. */
export async function currentTenant(): Promise<TenantContext> {
  return tenantFrom(await headers());
}
