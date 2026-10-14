import type { Pool } from "pg";
import { Gauge, type Registry } from "prom-client";
import type { CellRegistration, MerchantSignInRequest, MerchantSignInResult, TenantRouteTable } from "@shop/contracts";
import { createService, requireSecretHeader, secretsEqual, uuidPatternSource } from "@shop/service-kit";
import { type CellCredentials, cellIdPattern } from "@shop/tenancy";
import { cellRoutes, register } from "./cells.ts";
import { fleetView } from "./fleet.ts";
import { act, listPromotions, listTenants, type OperatorAction, tenantEvents } from "./operator.ts";
import { listExports, requestExport } from "./exports.ts";
import { requestMove } from "./move.ts";
import { isPassword } from "./passwords.ts";
import { merchantCredential, routingTable } from "./registry.ts";
import { requestRestore } from "./restore.ts";

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

  // Phase 5: the cells' tenant-labelled metrics carry only the tenant id; this maps each to its
  // handle, plan, and cell, for dashboards and for alerts that apply to one plan (`* on (tenant_id)
  // group_left (tenant, plan) tenant_info`). Read at scrape time; deleted shops are left out.
  new Gauge({
    name: "tenant_info",
    help: "1 for every shop that is not deleted, labelled with its id, handle, plan, cell, and whether it is internal",
    labelNames: ["tenant_id", "tenant", "plan", "cell", "internal"] as const,
    registers: [deps.registry],
    async collect() {
      const { rows } = await deps.db.query<{ id: string; handle: string; plan: string; cell: string | null; internal: boolean }>(
        "SELECT id, handle, plan, cell, internal FROM platform.tenants WHERE status <> 'DELETED'",
      );
      this.reset();
      for (const row of rows) {
        this.set({ tenant_id: row.id, tenant: row.handle, plan: row.plan, cell: row.cell ?? "", internal: String(row.internal) }, 1);
      }
    },
  });

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
      // A shop frozen for a move or a restore (Phase 6) can still be signed in to: its admin reads.
      const ok = signInStatuses.has(credential.status) && (await isPassword(req.body.password, credential.hash));
      req.log.info({ tenantId: req.body.tenantId, ok }, "merchant sign-in checked");
      return ok ? { ok: true, credentialVersion: credential.credentialVersion } : { ok: false };
    },
  );

  // The platform operator's actions. Reached by port-forward, `make tenant-*`, and `make fleet` only.
  const operatorOnly = { preHandler: requireSecretHeader("x-operator-token", deps.operatorToken) };

  app.get("/operator/tenants", operatorOnly, async () => ({ tenants: await listTenants(deps.db) }));

  app.get("/operator/cells", operatorOnly, async () => ({ cells: await fleetView(deps.db) }));

  app.get("/operator/promotions", operatorOnly, async () => ({ promotions: await listPromotions(deps.db) }));

  app.get<{ Params: { handle: string } }>("/operator/tenants/:handle/events", operatorOnly, async (req) => ({
    events: await tenantEvents(deps.db, req.params.handle),
  }));

  // A tenant move (Phase 6): the shop is frozen at once and moved by the lifecycle worker; its
  // events show each step. 409 names why a move is refused.
  app.post<{ Params: { handle: string }; Body: { cell: string } }>(
    "/operator/tenants/:handle/move",
    {
      ...operatorOnly,
      schema: { body: { type: "object", required: ["cell"], properties: { cell: { type: "string", minLength: 1, maxLength: 63 } } } },
    },
    async (req, reply) => {
      const result = await requestMove(deps.db, req.params.handle, req.body.cell);
      if (result.outcome === "not_found") return reply.code(404).send({ error: "tenant_not_found", message: "no such shop" });
      if (result.outcome === "refused") return reply.code(409).send({ error: result.reason, message: result.message });
      req.log.info({ tenantId: result.tenantId, from: result.from, to: result.to, planAfter: result.planAfter }, "tenant move requested");
      return reply.code(202).send({ handle: req.params.handle, status: "MOVING", from: result.from, to: result.to, planAfter: result.planAfter });
    },
  );

  // Per-tenant exports and restores (Phase 6). The exports live on the platform worker's volume;
  // their records here say what each holds. A restore loses what the shop changed since its export.
  app.get<{ Params: { handle: string } }>("/operator/tenants/:handle/exports", operatorOnly, async (req, reply) => {
    const exports = await listExports(deps.db, req.params.handle);
    if (!exports) return reply.code(404).send({ error: "tenant_not_found", message: "no such shop" });
    return { exports };
  });

  app.post<{ Params: { handle: string } }>("/operator/tenants/:handle/exports", operatorOnly, async (req, reply) => {
    const result = await requestExport(deps.db, req.params.handle);
    if (result.outcome === "not_found") return reply.code(404).send({ error: "tenant_not_found", message: "no such shop" });
    if (result.outcome === "not_active") return reply.code(409).send({ error: "not_allowed", message: `cannot export a shop that is ${result.status}` });
    return reply.code(202).send({ handle: req.params.handle, export: "requested" });
  });

  app.post<{ Params: { handle: string }; Body: { export: string } }>(
    "/operator/tenants/:handle/restore",
    {
      ...operatorOnly,
      schema: { body: { type: "object", required: ["export"], properties: { export: { type: "string", pattern: uuidPatternSource } } } },
    },
    async (req, reply) => {
      const result = await requestRestore(deps.db, req.params.handle, req.body.export);
      if (result.outcome === "not_found") {
        return reply.code(404).send({ error: `${result.what === "shop" ? "tenant" : "export"}_not_found`, message: `no such ${result.what}` });
      }
      if (result.outcome === "refused") return reply.code(409).send({ error: "not_allowed", message: result.message });
      req.log.info({ tenantId: result.tenantId, export: req.body.export, takenAt: result.takenAt }, "tenant restore requested");
      return reply.code(202).send({
        handle: req.params.handle,
        status: "RESTORING",
        export: req.body.export,
        takenAt: result.takenAt,
        warning: `everything the shop changed since ${result.takenAt} is lost`,
      });
    },
  );

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

const signInStatuses: ReadonlySet<string> = new Set(["ACTIVE", "MOVING", "RESTORING"]);
