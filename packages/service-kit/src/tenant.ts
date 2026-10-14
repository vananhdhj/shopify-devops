import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { tenantContextHeader, type TenantContext, type TenantContextSecrets, verifyTenantContext } from "@shop/tenancy";
import { annotateSpan } from "./tracing.ts";
import { withTransaction } from "./transactions.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** False for routes that serve no tenant: probes, scrapes, and worker-only internal routes. */
    tenantContext?: boolean;
  }
}

/** Route options for a route outside any tenant. Every other route requires a tenant context. */
export const withoutTenant = { config: { tenantContext: false } } as const;

const tenants = new WeakMap<FastifyRequest, TenantContext>();
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses every request that lacks a valid signed tenant context (401 `tenant_context_required`),
 * except on routes marked `withoutTenant`, and every write for a read-only one (503 `shop_updating`). The default is refusal, so a new route cannot forget
 * the check. Request log lines then carry the tenant id.
 */
export function requireTenantContext(app: FastifyInstance, secret: TenantContextSecrets): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.config?.tenantContext === false) return;
    const tenant = verifyTenantContext(req.headers[tenantContextHeader], secret);
    if (!tenant) {
      return reply.code(401).send({ error: "tenant_context_required", message: "a valid tenant context is required" });
    }
    tenants.set(req, tenant);
    reply.log = req.log = req.log.child({ tenantId: tenant.id });
    annotateSpan({ "tenant.id": tenant.id });
    // A shop frozen for a move or a restore (Phase 6) is read, never written: its rows are being
    // copied or replaced. Internal routes (the worker's settlement) carry no tenant context.
    if (tenant.readOnly && !readMethods.has(req.method)) {
      return reply
        .code(503)
        .header("retry-after", "5")
        .send({ error: "shop_updating", message: "this shop is updating; try again in a moment" });
    }
  });
}

/**
 * The tenant this request was verified for, with the limits it is held to. Throws on a route that
 * requires no tenant context.
 */
export function tenantOf(req: FastifyRequest): TenantContext {
  const tenant = tenants.get(req);
  if (!tenant) throw new Error(`no tenant context on ${req.routeOptions.url}`);
  return tenant;
}

/** Anything that runs queries: a pool client inside `withTenant`. */
export type Queryable = Pick<pg.ClientBase, "query">;

/**
 * Runs `work` in one transaction scoped to `tenantId`: row-level security then shows and
 * accepts only that tenant's rows. The setting is transaction-local, so a pooled connection
 * never carries one tenant into another's request.
 */
export async function withTenant<T>(db: pg.Pool, tenantId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(db, async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return work(client);
  });
}
