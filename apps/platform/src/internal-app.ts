import type { Pool } from "pg";
import type { Registry } from "prom-client";
import type { MerchantSignInRequest, MerchantSignInResult, TenantRouteTable } from "@shop/contracts";
import { createService, requireSecretHeader, uuidPatternSource } from "@shop/service-kit";
import { isPassword } from "./passwords.ts";
import { merchantCredential, routingTable } from "./registry.ts";

export interface InternalAppDeps {
  db: Pool;
  /** Shared with the public listener, so one /metrics covers both. */
  registry: Registry;
  environment: string;
  routerToken: string;
  storefrontToken: string;
}

const signInBody = {
  type: "object",
  required: ["tenantId", "password"],
  properties: {
    tenantId: { type: "string", pattern: uuidPatternSource },
    password: { type: "string", maxLength: 200 },
  },
} as const;

/**
 * The control plane's internal listener: what the cells' routers, storefronts, and the operator
 * call. Health and metrics live here too. It is never behind the ingress; the public signup pages
 * are a separate listener (ticket 03).
 */
export function buildInternalApp(deps: InternalAppDeps) {
  const app = createService({ name: "platform-api", environment: deps.environment, db: deps.db, registry: deps.registry });

  app.get(
    "/internal/routes",
    { preHandler: requireSecretHeader("x-platform-token", deps.routerToken) },
    async (): Promise<TenantRouteTable> => ({ tenants: await routingTable(deps.db) }),
  );

  // A cell's storefront asks whether a password is this shop's. Only an active shop can be signed
  // in to; an unknown tenant, a wrong password, and a suspended shop all answer the same "no".
  app.post<{ Body: MerchantSignInRequest }>(
    "/internal/merchant-sign-ins",
    { preHandler: requireSecretHeader("x-platform-token", deps.storefrontToken), schema: { body: signInBody } },
    async (req): Promise<MerchantSignInResult> => {
      const credential = await merchantCredential(deps.db, req.body.tenantId.toLowerCase());
      const ok =
        credential?.status === "ACTIVE" && (await isPassword(req.body.password, credential.hash));
      req.log.info({ tenantId: req.body.tenantId, ok }, "merchant sign-in checked");
      return ok ? { ok: true, credentialVersion: credential.credentialVersion } : { ok: false };
    },
  );

  return app;
}
