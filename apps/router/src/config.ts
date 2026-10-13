import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  port: Number(process.env.PORT ?? 8000),
  /** Private listener for health and metrics: the public port is on the ingress. */
  opsPort: Number(process.env.OPS_PORT ?? 8001),
  environment: process.env.APP_ENV ?? "dev",
  /** Shops live at `<handle>.<baseDomain>`. */
  baseDomain: required("TENANT_BASE_DOMAIN").toLowerCase(),
  /**
   * Each cell's tenant-context secret, one file per cell (`<cell>.tenant-context-secret`); every
   * shop goes to its cell's storefront, from the routing table, with a context signed by it.
   */
  cellCredentialsDir: required("CELL_CREDENTIALS_DIR"),
  /** The control plane's internal listener, where the routing table is read. */
  platformApiUrl: required("PLATFORM_API_URL"),
  /** The control plane's public listener: the signup pages at the bare base domain. */
  platformPublicUrl: required("PLATFORM_PUBLIC_URL"),
  routerToken: required("PLATFORM_ROUTER_TOKEN"),
  routesRefreshMs: Number(process.env.ROUTES_REFRESH_MS ?? 2_000),
  /** Handles (and `platform`) never rate limited: none in the cluster; the Compose test stack's seeded shops. */
  rateLimitExempt: new Set((process.env.RATE_LIMIT_EXEMPT ?? "").split(",").filter(Boolean)),
  /** In the pod's /tmp (an emptyDir in the cluster), so it survives a container restart. */
  routesCacheFile: process.env.ROUTES_CACHE_FILE ?? "/tmp/routing-table.json",
};
