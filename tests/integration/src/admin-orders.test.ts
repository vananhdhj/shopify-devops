import { describe, expect, it } from "vitest";
import { adminListOrders, adminSetStatus } from "./admin.ts";
import { asIdentity } from "./db.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf, readOrder, settled, statusChanges } from "./shopping.ts";
import { compose, restartService } from "./stack.ts";

describe("admin orders (order service)", () => {
  it("refuses the admin endpoints without the admin service token", async () => {
    const { orderId } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");

    expect((await adminListOrders(null)).status).toBe(401);
    expect((await adminListOrders("wrong-token")).status).toBe(401);
    expect((await adminSetStatus(orderId, "FULFILLED", null)).status).toBe(401);
  });

  it("lists Orders with their status for the Merchant", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    await settled(orderId, orderToken);

    const list = await adminListOrders();
    expect(list.status).toBe(200);
    expect(list.body.orders).toContainEqual(expect.objectContaining({ id: orderId, status: "CONFIRMED" }));
  });

  it("marks a Confirmed order Fulfilled, recording the status change", async () => {
    const { orderId, orderToken } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    expect((await settled(orderId, orderToken)).status).toBe("CONFIRMED");

    expect(await adminSetStatus(orderId, "FULFILLED")).toMatchObject({ status: 200, body: { status: "FULFILLED" } });
    expect((await readOrder(orderId, orderToken)).body.status).toBe("FULFILLED");
    expect(await statusChanges(orderId)).toEqual([
      { from_status: "PENDING", to_status: "CONFIRMED" },
      { from_status: "CONFIRMED", to_status: "FULFILLED" },
    ]);
  });

  it("refuses to fulfill a Pending or a Rejected order", async () => {
    // With the worker stopped, nothing can settle the Order: it is Pending for certain.
    compose("stop", "worker");
    try {
      const pending = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
      expect(await adminSetStatus(pending.orderId, "FULFILLED")).toMatchObject({
        status: 409,
        body: { error: "illegal_transition" },
      });
    } finally {
      restartService("worker");
    }

    const declined = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "decline");
    expect((await settled(declined.orderId, declined.orderToken)).status).toBe("REJECTED_PAYMENT");
    expect(await adminSetStatus(declined.orderId, "FULFILLED")).toMatchObject({
      status: 409,
      body: { error: "illegal_transition" },
    });
    expect((await readOrder(declined.orderId, declined.orderToken)).body.status).toBe("REJECTED_PAYMENT");
  });

  it("refuses any other target status and unknown Orders", async () => {
    const { orderId } = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "approve");
    expect((await adminSetStatus(orderId, "CONFIRMED")).status).toBe(400);
    expect((await adminSetStatus("00000000-0000-4000-8000-00000000f00d", "FULFILLED")).status).toBe(404);
  });

  it("lets the database itself refuse an illegal status change, whoever attempts it", async () => {
    const declined = await checkoutOf({ [seedProducts.notebookSet]: 1 }, "decline");
    await settled(declined.orderId, declined.orderToken);

    const attempt = (orderId: string, status: string) =>
      asIdentity("orders", async (db) => {
        try {
          await db.query("UPDATE orders.orders SET status = $2 WHERE id = $1", [orderId, status]);
          return "allowed";
        } catch (err) {
          return (err as { code?: string }).code === "23514" ? "refused" : `error ${(err as Error).message}`;
        }
      });

    expect(await attempt(declined.orderId, "FULFILLED")).toBe("refused");
    expect(await attempt(declined.orderId, "PENDING")).toBe("refused");
  });
});
