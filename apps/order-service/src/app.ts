import type { Pool } from "pg";
import type { AdminOrderList, AdminStatusChange, CheckoutAccepted, CheckoutRefusal, CheckoutRequest } from "@shop/contracts";
import { createService, isUuid, requireSecretHeader, tenantOf, withTenant, withoutTenant } from "@shop/service-kit";
import { planLimits, tenantContextHeader, type TenantContextSecrets } from "@shop/tenancy";
import { Counter, Histogram } from "prom-client";
import { fulfillOrder, listOrders } from "./admin.ts";
import { orderMetrics } from "./metrics.ts";
import { CatalogUnavailableError } from "./catalog-client.ts";
import { acceptCheckout } from "./checkout.ts";
import { isValidOrderToken, orderTokenFor } from "./order-tokens.ts";
import { InFlight } from "./in-flight.ts";
import { findOrder } from "./orders.ts";

export interface AppDeps {
  db: Pool;
  environment: string;
  catalogApiUrl: string;
  orderTokenSecret: string;
  /** Presented by the storefront on behalf of the signed-in Merchant. */
  adminServiceToken: string;
  /** Presented by the control plane to purge a deleted shop from this cell. */
  platformCellToken: string;
  /** Verifies the tenant context every business request carries (from the router, via the storefront). */
  tenantContextSecret: TenantContextSecrets;
  /** Fails every Checkout with 500, standing in for a bad release in the rollback drill. */
  checkoutFault?: boolean;
  /**
   * Shop handles without a Checkout cap: none in the cluster. The Compose test stack exempts the
   * seeded shops, whose contention tests send 100 concurrent Checkouts.
   */
  checkoutLimitExempt?: ReadonlySet<string>;
}

const statusChangeBody = {
  type: "object",
  required: ["status"],
  properties: { status: { type: "string", enum: ["FULFILLED"] } },
} as const;

const checkoutBody = {
  type: "object",
  required: ["cartToken", "checkoutKey", "paymentScenario"],
  properties: {
    cartToken: { type: "string" },
    checkoutKey: { type: "string", minLength: 8, maxLength: 128 },
    paymentScenario: { type: "string", enum: ["approve", "decline", "slow"] },
  },
} as const;

const refusalStatus: Record<CheckoutRefusal, number> = {
  cart_not_found: 404,
  cart_empty: 422,
  checkout_key_reused: 409,
  cart_already_ordered: 409,
};

export function buildApp(deps: AppDeps) {
  const registry = orderMetrics(deps.db);
  const app = createService({
    name: "order-service",
    environment: deps.environment,
    db: deps.db,
    registry,
    tenantContextSecret: deps.tenantContextSecret,
  });
  const inFlight = new InFlight();
  const busy = new Counter({
    name: "checkouts_busy_total",
    help: "Checkouts refused with 429 because the shop already had its plan's Checkouts in flight, by tenant",
    labelNames: ["tenant_id"] as const,
    registers: [registry],
  });
  // Phase 5's tenant dimension: Checkout latency per shop, by outcome.
  const checkoutDuration = new Histogram({
    name: "checkout_duration_seconds",
    help: "Checkout duration by tenant and outcome (accepted, refused, busy, unavailable, error)",
    labelNames: ["tenant_id", "outcome"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.post<{ Body: CheckoutRequest }>("/checkout", { schema: { body: checkoutBody } }, async (req, reply) => {
    const started = process.hrtime.bigint();
    const observe = (outcome: string) =>
      checkoutDuration.observe({ tenant_id: tenantOf(req).id, outcome }, Number(process.hrtime.bigint() - started) / 1e9);
    const refuse = (reason: CheckoutRefusal) => {
      observe("refused");
      return reply.code(refusalStatus[reason]).send({ error: reason, message: reason.replaceAll("_", " ") });
    };

    if (deps.checkoutFault) throw new Error("checkout fault injected (FAULT_CHECKOUT_ERRORS)");
    if (!isUuid(req.body.cartToken)) return refuse("cart_not_found");
    // The shop's cap on Checkouts in flight (Phase 5): past it, the buyer retries in a moment while
    // the cell's database connections stay free for every other shop.
    const shop = tenantOf(req);
    const capped = !deps.checkoutLimitExempt?.has(shop.handle);
    if (capped && !inFlight.tryTake(shop.id, planLimits[shop.plan].checkoutsInFlight)) {
      busy.inc({ tenant_id: shop.id });
      observe("busy");
      return reply
        .code(429)
        .header("retry-after", "1")
        .send({ error: "checkout_busy", message: "this shop has as many checkouts in progress as its plan allows; try again in a moment" });
    }
    try {
      const request = { ...req.body, cartToken: req.body.cartToken.toLowerCase() };
      const tenant = { id: tenantOf(req).id, context: String(req.headers[tenantContextHeader]) };
      const result = await acceptCheckout(deps.db, deps.catalogApiUrl, tenant, request);
      if (result.outcome === "refused") return refuse(result.reason);
      req.log.info({ orderId: result.orderId }, "checkout accepted");
      observe("accepted");
      const accepted: CheckoutAccepted = {
        orderId: result.orderId,
        orderToken: orderTokenFor(tenant.id, result.orderId, deps.orderTokenSecret),
        status: "PENDING",
      };
      return reply.code(202).header("location", `/orders/${result.orderId}`).send(accepted);
    } catch (err) {
      if (!(err instanceof CatalogUnavailableError)) {
        observe("error");
        throw err;
      }
      observe("unavailable");
      req.log.warn({ err }, "catalog unavailable during checkout");
      return reply.code(503).send({ error: "dependency_unavailable", message: "try again shortly" });
    } finally {
      if (capped) inFlight.release(shop.id);
    }
  });

  // A wrong or missing Order token, or another shop's Order, answers exactly like an unknown
  // order: no existence leak.
  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const { id } = req.params;
    const tenantId = tenantOf(req).id;
    const token = req.headers["x-order-token"];
    const authorised =
      isUuid(id) && typeof token === "string" && isValidOrderToken(tenantId, id, token, deps.orderTokenSecret);
    const order = authorised ? await withTenant(deps.db, tenantId, (client) => findOrder(client, id)) : undefined;
    if (!order) return reply.code(404).send({ error: "order_not_found", message: "order not found" });
    return order;
  });

  const adminOnly = { preHandler: requireSecretHeader("x-admin-token", deps.adminServiceToken) };

  app.get("/admin/orders", adminOnly, async (req): Promise<AdminOrderList> =>
    withTenant(deps.db, tenantOf(req).id, listOrders),
  );

  app.patch<{ Params: { id: string }; Body: AdminStatusChange }>(
    "/admin/orders/:id/status",
    { ...adminOnly, schema: { body: statusChangeBody } },
    async (req, reply) => {
      const { id } = req.params;
      const result = isUuid(id)
        ? await withTenant(deps.db, tenantOf(req).id, (client) => fulfillOrder(client, id))
        : "order_not_found";
      if (result === "order_not_found") return reply.code(404).send({ error: result, message: "order not found" });
      if (result === "illegal_transition") {
        return reply.code(409).send({ error: result, message: "only a Confirmed order can be fulfilled" });
      }
      req.log.info({ orderId: id }, "order fulfilled");
      return { id, status: "FULFILLED" };
    },
  );


  // Internal: the control plane deletes a shop from this cell. Refused without the cell token,
  // which only the control plane holds; outside any tenant context, because the shop is no longer
  // routed. The schema's narrow purge function does the deleting (ADR-0012's pattern) and reports
  // what it removed and what of the shop is left.
  app.post<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/purge",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const { rows } = await deps.db.query<{ report: { deleted: Record<string, number>; remaining: Record<string, number> } }>(
        "SELECT orders.purge_tenant($1) AS report",
        [tenantId.toLowerCase()],
      );
      req.log.info({ tenantId, ...rows[0]!.report }, "tenant purged");
      return rows[0]!.report;
    },
  );

  // Internal, Phase 6: the control plane moves or restores a shop by exporting its rows from one
  // cell, importing them into another, and comparing each table's count and checksum in both. Same
  // token and pattern as a purge: the schema's narrow functions do the work, scoped to one tenant.
  // An import refuses a shop that already has rows here (409) and rows of another tenant (422).
  app.post<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/export",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const tenant = tenantId.toLowerCase();
      const { rows } = await deps.db.query<{ rows: Record<string, unknown[]>; checksums: TenantChecksums }>(
        "SELECT orders.export_tenant($1) AS rows, orders.tenant_checksums($1) AS checksums",
        [tenant],
      );
      req.log.info({ tenantId, checksums: rows[0]!.checksums }, "tenant exported");
      return { tenantId: tenant, ...rows[0]! };
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { rows: Record<string, unknown[]> } }>(
    "/internal/tenants/:tenantId/import",
    {
      ...withoutTenant,
      preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken),
      bodyLimit: importBodyLimit,
      schema: { body: { type: "object", required: ["rows"], properties: { rows: { type: "object" } } } },
    },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      try {
        const { rows } = await deps.db.query<{ checksums: TenantChecksums }>(
          "SELECT orders.import_tenant($1, $2) AS checksums",
          [tenantId.toLowerCase(), JSON.stringify(req.body.rows)],
        );
        req.log.info({ tenantId, checksums: rows[0]!.checksums }, "tenant imported");
        return { checksums: rows[0]!.checksums };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "23505") return reply.code(409).send({ error: "tenant_not_empty", message: (err as Error).message });
        if (code === "23514") return reply.code(422).send({ error: "rows_refused", message: (err as Error).message });
        throw err;
      }
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/internal/tenants/:tenantId/checksums",
    { ...withoutTenant, preHandler: requireSecretHeader("x-platform-token", deps.platformCellToken) },
    async (req, reply) => {
      const { tenantId } = req.params;
      if (!isUuid(tenantId)) return reply.code(404).send({ error: "tenant_not_found", message: "not a tenant id" });
      const { rows } = await deps.db.query<{ checksums: TenantChecksums }>(
        "SELECT orders.tenant_checksums($1) AS checksums",
        [tenantId.toLowerCase()],
      );
      return { checksums: rows[0]!.checksums };
    },
  );

  return app;
}

/** Each table's row count and md5 over its rows in key order, as the schema computes them. */
type TenantChecksums = Record<string, { rows: number; md5: string }>;

/** A shop's rows arrive in one request; lab shops are far smaller than this. */
const importBodyLimit = 32 * 1024 * 1024;
