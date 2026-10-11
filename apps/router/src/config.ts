import { readFileSync } from "node:fs";
import { requiredEnv as required } from "@shop/service-kit";
import { parseTenantTable } from "@shop/tenancy";

const platformApiUrl = process.env.PLATFORM_API_URL;

export const config = {
  port: Number(process.env.PORT ?? 8000),
  /** Private listener for health and metrics: the public port is on the ingress. */
  opsPort: Number(process.env.OPS_PORT ?? 8001),
  environment: process.env.APP_ENV ?? "dev",
  storefrontUrl: required("STOREFRONT_URL"),
  /** Shops live at `<handle>.<baseDomain>`. */
  baseDomain: required("TENANT_BASE_DOMAIN").toLowerCase(),
  tenantContextSecret: required("TENANT_CONTEXT_SECRET"),
  /**
   * Registry mode: the control plane's routing table, refreshed every `routesRefreshMs`. Without
   * PLATFORM_API_URL the router reads the static tenant table of Phase 1 instead (TENANTS_FILE),
   * read once at startup, so a missing or invalid table stops it before it serves anything.
   */
  registry: platformApiUrl
    ? {
        platformApiUrl,
        routerToken: required("PLATFORM_ROUTER_TOKEN"),
        routesRefreshMs: Number(process.env.ROUTES_REFRESH_MS ?? 2_000),
      }
    : undefined,
  staticTenants: platformApiUrl ? undefined : parseTenantTable(readFileSync(required("TENANTS_FILE"), "utf8")),
};
