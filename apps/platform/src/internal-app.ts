import type { Pool } from "pg";
import type { Registry } from "prom-client";
import type { CellRegistration, MerchantSignInRequest, MerchantSignInResult, TenantRouteTable } from "@shop/contracts";
import { createService, requireSecretHeader, secretsEqual, uuidPatternSource } from "@shop/service-kit";
import { type CellCredentials, cellIdPattern } from "@shop/tenancy";
import { cellRoutes, register } from "./cells.ts";
import { fleetView } from "./fleet.ts";
import { act, listTenants, type OperatorAction, tenantEvents } from "./operator.ts";
import { isPassword } from "./passwords.ts";
import { merchantCredential, routingTable } from "./registry.ts";

export interface InternalAppDeps {
  db: Pool;
  /** Shared with the public listener, so one /metrics covers both. */
  registry: Registry;
  environment: string;
  routerToken: string;
  /** Each cell's own tokens: a cell is trusted for itself and its own shops only. */
  credentials: CellCredentials;
  operatorToken: string;
}

const signInBody = {
  type: "object",
  required: ["tenantId", "password"],
  properties: {
    tenantId: { type: "string", pattern: uuidPatternSource },
    password: { type: "string", maxLength: 200 },
  },
} as const;

const url = { type: "string", pattern: "^https?://[^\\s]+$", maxLength: 200 } as const;
const registrationBody = {
  type: "object",
  required: ["role", "capacity", "storefrontUrl", "catalogUrl", "ordersUrl"],
  additionalProperties: false,
  properties: {
    role: { type: "string", enum: ["canary", "pooled", "dedicated"] },
    capacity: { type: "integer", minimum: 1, maximum: 10_000 },
    storefrontUrl: url,
    catalogUrl: url,
    ordersUrl: url,
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
    async (): Promise<TenantRouteTable> => ({ tenants: await routingTable(deps.db), cells: await cellRoutes(deps.db) }),
  );

  // A cell enters the directory, or refreshes its entry, once its units are healthy (a PostSync
  // hook in the cluster). Only the cell's own token registers it, so no cell can claim another's
  // id or point another cell's shops at itself.
  app.post<{ Params: { id: string }; Body: CellRegistration }>(
    "/internal/cells/:id/registration",
    { schema: { body: registrationBody } },
    async (req, reply) => {
      const { id } = req.params;
      const expected = cellIdPattern.test(id) ? deps.credentials.get(id, "platform-cell-token") : undefined;
      if (!expected || !secretsEqual(req.headers["x-platform-token"], expected)) {
        return reply.code(401).send({ error: "unauthorized", message: "x-platform-token of this cell required" });
      }
      const result = await register(deps.db, id, req.body);
      if (result.outcome === "refused") {
        req.log.warn({ cell: id, reason: result.reason }, "cell registration refused");
        return reply.code(409).send({ error: "registration_refused", message: result.reason });
      }
      req.log.info({ cell: id, role: req.body.role, capacity: req.body.capacity, created: result.created }, "cell registered");
      return { cell: id, registered: true };
    },
  );

  // A cell's storefront asks whether a password is this shop's. Only the storefront of the cell
  // holding the shop may ask (its own token), so a cell cannot probe another cell's Merchants.
  // Only an active shop can be signed in to; a wrong password and a suspended shop answer the
  // same "no".
  app.post<{ Body: MerchantSignInRequest }>(
    "/internal/merchant-sign-ins",
    { schema: { body: signInBody } },
    async (req, reply): Promise<MerchantSignInResult | undefined> => {
      const credential = await merchantCredential(deps.db, req.body.tenantId.toLowerCase());
      const expected = credential?.cell ? deps.credentials.get(credential.cell, "storefront-token") : undefined;
      if (!credential || !expected || !secretsEqual(req.headers["x-platform-token"], expected)) {
        req.log.warn({ tenantId: req.body.tenantId }, "sign-in check refused: not the storefront of the shop's cell");
        return reply.code(401).send({ error: "unauthorized", message: "x-platform-token of the shop's cell required" });
      }
      const ok = credential.status === "ACTIVE" && (await isPassword(req.body.password, credential.hash));
      req.log.info({ tenantId: req.body.tenantId, ok }, "merchant sign-in checked");
      return ok ? { ok: true, credentialVersion: credential.credentialVersion } : { ok: false };
    },
  );

  // The platform operator's actions. Reached by port-forward, `make tenant-*`, and `make fleet` only.
  const operatorOnly = { preHandler: requireSecretHeader("x-operator-token", deps.operatorToken) };

  app.get("/operator/tenants", operatorOnly, async () => ({ tenants: await listTenants(deps.db) }));

  app.get("/operator/cells", operatorOnly, async () => ({ cells: await fleetView(deps.db) }));

  app.get<{ Params: { handle: string } }>("/operator/tenants/:handle/events", operatorOnly, async (req) => ({
    events: await tenantEvents(deps.db, req.params.handle),
  }));

  app.post<{ Params: { handle: string; action: string } }>(
    "/operator/tenants/:handle/:action",
    operatorOnly,
    async (req, reply) => {
      const action = req.params.action as OperatorAction;
      if (!["suspend", "reinstate", "delete"].includes(action)) {
        return reply.code(404).send({ error: "unknown_action", message: "suspend, reinstate, or delete" });
      }
      const result = await act(deps.db, req.params.handle, action);
      if (result.outcome === "not_found") return reply.code(404).send({ error: "tenant_not_found", message: "no such shop" });
      if (result.outcome === "not_allowed") {
        return reply.code(409).send({ error: "not_allowed", message: `cannot ${action} a shop that is ${result.status}` });
      }
      req.log.info({ tenantId: result.tenantId, action, status: result.status }, "operator action");
      return { handle: req.params.handle, status: result.status };
    },
  );

  return app;
}
