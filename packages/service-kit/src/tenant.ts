import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { tenantContextHeader, verifyTenantContext, type Tenant } from "@shop/tenancy";
import { withTransaction } from "./transactions.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** False for routes that serve no tenant: probes, scrapes, and worker-only internal routes. */
    tenantContext?: boolean;
  }
}

/** Route options for a route outside any tenant. Every other route requires a tenant context. */
export const withoutTenant = { config: { tenantContext: false } } as const;

const tenants = new WeakMap<FastifyRequest, Tenant>();

/**
 * Refuses every request that lacks a valid signed tenant context (401 `tenant_context_required`),
 * except on routes marked `withoutTenant`. The default is refusal, so a new route cannot forget
 * the check. Request log lines then carry the tenant id.
 */
export function requireTenantContext(app: FastifyInstance, secret: string): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions.config?.tenantContext === false) return;
    const tenant = verifyTenantContext(req.headers[tenantContextHeader], secret);
    if (!tenant) {
      return reply.code(401).send({ error: "tenant_context_required", message: "a valid tenant context is required" });
    }
    tenants.set(req, tenant);
    reply.log = req.log = req.log.child({ tenantId: tenant.id });
  });
}

/** The tenant this request was verified for. Throws on a route that requires no tenant context. */
export function tenantOf(req: FastifyRequest): Tenant {
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
