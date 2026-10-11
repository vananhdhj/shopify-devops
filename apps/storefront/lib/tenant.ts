import "server-only";
import { headers } from "next/headers";
import { tenantContextHeader, type TenantContext, verifyTenantContext } from "@shop/tenancy";
import { requiredEnv } from "./env";

/**
 * The shop this request is for, from the router's signed tenant context. proxy.ts has already
 * refused requests without a valid one, so a page or handler always has a tenant.
 */
export function tenantFrom(requestHeaders: Headers): TenantContext {
  const tenant = verifyTenantContext(requestHeaders.get(tenantContextHeader), requiredEnv("TENANT_CONTEXT_SECRET"));
  if (!tenant) throw new Error("request reached the storefront without a valid tenant context");
  return tenant;
}

/** The current request's shop, for pages and layouts. */
export async function currentTenant(): Promise<TenantContext> {
  return tenantFrom(await headers());
}
