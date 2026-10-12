import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  /** The signup pages: the only listener the router forwards from the bare platform address. */
  publicPort: Number(process.env.PUBLIC_PORT ?? 8100),
  /** The listener for the router, the storefront, the cells, and the operator; never on the ingress. */
  internalPort: Number(process.env.INTERNAL_PORT ?? 8101),
  /** Shops live at `<handle>.<baseDomain>`; the signup pages are at the bare base domain. */
  baseDomain: required("TENANT_BASE_DOMAIN").toLowerCase(),
  databaseUrl: required("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  /** Presented by the routers to read the routing table. */
  routerToken: required("PLATFORM_ROUTER_TOKEN"),
  /**
   * Each cell's own secrets, one file per cell and key (`<cell>.platform-cell-token`,
   * `<cell>.storefront-token`): a cell registers with its cell token, and its storefront checks
   * sign-ins with its storefront token, for its own shops only.
   */
  cellCredentialsDir: required("CELL_CREDENTIALS_DIR"),
  /** Presented by the platform operator (make tenant-*), never by any unit. */
  operatorToken: required("PLATFORM_OPERATOR_TOKEN"),
};
