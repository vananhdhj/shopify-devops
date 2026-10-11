import type { Pool } from "pg";
import type { TenantRouteTable } from "@shop/contracts";
import { createService, requireSecretHeader } from "@shop/service-kit";
import { routingTable } from "./registry.ts";

export interface InternalAppDeps {
  db: Pool;
  environment: string;
  routerToken: string;
}

/**
 * The control plane's internal listener: what the cells' routers, storefronts, and the operator
 * call. Health and metrics live here too. It is never behind the ingress; the public signup pages
 * are a separate listener (ticket 03).
 */
export function buildInternalApp(deps: InternalAppDeps) {
  const app = createService({ name: "platform-api", environment: deps.environment, db: deps.db });

  app.get(
    "/internal/routes",
    { preHandler: requireSecretHeader("x-platform-token", deps.routerToken) },
    async (): Promise<TenantRouteTable> => ({ tenants: await routingTable(deps.db) }),
  );

  return app;
}
