import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 8000),
  /** Private listener for health and metrics: the public port is on the ingress. */
  opsPort: Number(process.env.OPS_PORT ?? 8001),
  environment: process.env.APP_ENV ?? "dev",
  storefrontUrl: required("STOREFRONT_URL"),
  /** Shops live at `<handle>.<baseDomain>`. */
  baseDomain: required("TENANT_BASE_DOMAIN").toLowerCase(),
  tenantContextSecret: required("TENANT_CONTEXT_SECRET"),
  /** The control plane's internal listener, where the routing table is read. */
  platformApiUrl: required("PLATFORM_API_URL"),
  routerToken: required("PLATFORM_ROUTER_TOKEN"),
  routesRefreshMs: Number(process.env.ROUTES_REFRESH_MS ?? 2_000),
};
