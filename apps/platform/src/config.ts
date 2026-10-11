import { requiredEnv as required } from "@shop/service-kit";

export const config = {
  /** The listener for the router, the storefront, the cells, and the operator; never on the ingress. */
  internalPort: Number(process.env.INTERNAL_PORT ?? 8101),
  databaseUrl: required("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
  /** Presented by every cell's router to read the routing table. */
  routerToken: required("PLATFORM_ROUTER_TOKEN"),
  /** Presented by every cell's storefront to check a Merchant sign-in. */
  storefrontToken: required("PLATFORM_STOREFRONT_TOKEN"),
};
