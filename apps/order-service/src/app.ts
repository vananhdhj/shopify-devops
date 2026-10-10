import type { Pool } from "pg";
import type { AdminOrderList, AdminStatusChange, CheckoutAccepted, CheckoutRefusal, CheckoutRequest } from "@shop/contracts";
import { createService, isUuid, requireSecretHeader } from "@shop/service-kit";
import { fulfillOrder, listOrders } from "./admin.ts";
import { orderMetrics } from "./metrics.ts";
import { CatalogUnavailableError } from "./catalog-client.ts";
import { acceptCheckout } from "./checkout.ts";
import { isValidOrderToken, orderTokenFor } from "./order-tokens.ts";
import { findOrder } from "./orders.ts";

export interface AppDeps {
  db: Pool;
  environment: string;
  catalogApiUrl: string;
  orderTokenSecret: string;
  /** Presented by the storefront on behalf of the signed-in Merchant. */
  adminServiceToken: string;
  /** Fails every Checkout with 500, standing in for a bad release in the rollback drill. */
  checkoutFault?: boolean;
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
  const app = createService({
    name: "order-service",
    environment: deps.environment,
    db: deps.db,
    registry: orderMetrics(deps.db),
  });

  app.post<{ Body: CheckoutRequest }>("/checkout", { schema: { body: checkoutBody } }, async (req, reply) => {
    const refuse = (reason: CheckoutRefusal) =>
      reply.code(refusalStatus[reason]).send({ error: reason, message: reason.replaceAll("_", " ") });

    if (deps.checkoutFault) throw new Error("checkout fault injected (FAULT_CHECKOUT_ERRORS)");
    if (!isUuid(req.body.cartToken)) return refuse("cart_not_found");
    try {
      const request = { ...req.body, cartToken: req.body.cartToken.toLowerCase() };
      const result = await acceptCheckout(deps.db, deps.catalogApiUrl, request);
      if (result.outcome === "refused") return refuse(result.reason);
      req.log.info({ orderId: result.orderId }, "checkout accepted");
      const accepted: CheckoutAccepted = {
        orderId: result.orderId,
        orderToken: orderTokenFor(result.orderId, deps.orderTokenSecret),
        status: "PENDING",
      };
      return reply.code(202).header("location", `/orders/${result.orderId}`).send(accepted);
    } catch (err) {
      if (!(err instanceof CatalogUnavailableError)) throw err;
      req.log.warn({ err }, "catalog unavailable during checkout");
      return reply.code(503).send({ error: "dependency_unavailable", message: "try again shortly" });
    }
  });

  // A wrong or missing Order token answers exactly like an unknown order: no existence leak.
  app.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const { id } = req.params;
    const token = req.headers["x-order-token"];
    const authorised = isUuid(id) && typeof token === "string" && isValidOrderToken(id, token, deps.orderTokenSecret);
    const order = authorised ? await findOrder(deps.db, id) : undefined;
    if (!order) return reply.code(404).send({ error: "order_not_found", message: "order not found" });
    return order;
  });

  const adminOnly = { preHandler: requireSecretHeader("x-admin-token", deps.adminServiceToken) };

  app.get("/admin/orders", adminOnly, async (): Promise<AdminOrderList> => listOrders(deps.db));

  app.patch<{ Params: { id: string }; Body: AdminStatusChange }>(
    "/admin/orders/:id/status",
    { ...adminOnly, schema: { body: statusChangeBody } },
    async (req, reply) => {
      const { id } = req.params;
      const result = isUuid(id) ? await fulfillOrder(deps.db, id) : "order_not_found";
      if (result === "order_not_found") return reply.code(404).send({ error: result, message: "order not found" });
      if (result === "illegal_transition") {
        return reply.code(409).send({ error: result, message: "only a Confirmed order can be fulfilled" });
      }
      req.log.info({ orderId: id }, "order fulfilled");
      return { id, status: "FULFILLED" };
    },
  );

  return app;
}
