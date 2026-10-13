import type { Pool } from "pg";
import type { AdminOrderList, AdminStatusChange, CheckoutAccepted, CheckoutRefusal, CheckoutRequest } from "@shop/contracts";
import { createService, isUuid, requireSecretHeader, tenantOf, withTenant, withoutTenant } from "@shop/service-kit";
import { planLimits, tenantContextHeader } from "@shop/tenancy";
import { Counter } from "prom-client";
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
  tenantContextSecret: string;
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
    labelNames: ["tenant"] as const,
    registers: [registry],
  });

  app.post<{ Body: CheckoutRequest }>("/checkout", { schema: { body: checkoutBody } }, async (req, reply) => {
    const refuse = (reason: CheckoutRefusal) =>
      reply.code(refusalStatus[reason]).send({ error: reason, message: reason.replaceAll("_", " ") });

    if (deps.checkoutFault) throw new Error("checkout fault injected (FAULT_CHECKOUT_ERRORS)");
    if (!isUuid(req.body.cartToken)) return refuse("cart_not_found");
    // The shop's cap on Checkouts in flight (Phase 5): past it, the buyer retries in a moment while
    // the cell's database connections stay free for every other shop.
    const shop = tenantOf(req);
    const capped = !deps.checkoutLimitExempt?.has(shop.handle);
    if (capped && !inFlight.tryTake(shop.id, planLimits[shop.plan].checkoutsInFlight)) {
      busy.inc({ tenant: shop.handle });
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
      const accepted: CheckoutAccepted = {
        orderId: result.orderId,
        orderToken: orderTokenFor(tenant.id, result.orderId, deps.orderTokenSecret),
        status: "PENDING",
      };
      return reply.code(202).header("location", `/orders/${result.orderId}`).send(accepted);
    } catch (err) {
      if (!(err instanceof CatalogUnavailableError)) throw err;
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

  return app;
}
