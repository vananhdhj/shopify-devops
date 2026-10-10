import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./db.ts";
import { inventoryEffect, newOrderId, reseed, stockOf } from "./inventory.ts";
import { seedProducts } from "./seed.ts";

// Seed Stock: Olive Wood Board 8, Cotton Throw 6.
const board = seedProducts.oliveWoodBoard;
const throwBlanket = seedProducts.cottonThrow;

describe("inventory effects (internal)", () => {
  beforeAll(() => reseed());

  it("refuses callers without the internal token", async () => {
    const body = { orderId: newOrderId(), action: "deduct" as const, items: [{ productId: board, quantity: 1 }] };
    expect((await inventoryEffect(body, null)).status).toBe(401);
    expect((await inventoryEffect(body, "wrong-token")).status).toBe(401);
    expect(await stockOf(board)).toBe(8);
  });

  it("applies a deduction once, however many times it is requested", async () => {
    const body = { orderId: newOrderId(), action: "deduct" as const, items: [{ productId: board, quantity: 2 }] };

    const responses = await Promise.all(Array.from({ length: 10 }, () => inventoryEffect(body)));

    for (const res of responses) expect(res).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(await stockOf(board)).toBe(6);
    expect(await query("SELECT 1 FROM catalog.inventory_effects WHERE order_id = $1", [body.orderId])).toHaveLength(1);
  });

  it("deducts nothing at all when any line lacks Stock", async () => {
    const body = {
      orderId: newOrderId(),
      action: "deduct" as const,
      items: [
        { productId: board, quantity: 1 },
        { productId: throwBlanket, quantity: 7 },
      ],
    };

    expect(await inventoryEffect(body)).toMatchObject({ status: 200, body: { outcome: "insufficient_stock" } });
    expect(await inventoryEffect(body)).toMatchObject({ body: { outcome: "insufficient_stock" } });
    expect(await stockOf(board)).toBe(6);
    expect(await stockOf(throwBlanket)).toBe(6);
  });

  it("releases exactly what a deduction took, once", async () => {
    const orderId = newOrderId();
    await inventoryEffect({ orderId, action: "deduct", items: [{ productId: throwBlanket, quantity: 3 }] });
    expect(await stockOf(throwBlanket)).toBe(3);

    const release = { orderId, action: "release" as const, items: [] };
    expect(await inventoryEffect(release)).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(await inventoryEffect(release)).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(await stockOf(throwBlanket)).toBe(6);
  });

  it("releases nothing for an Order whose deduction never applied", async () => {
    const release = { orderId: newOrderId(), action: "release" as const, items: [] };
    expect(await inventoryEffect(release)).toMatchObject({ status: 200, body: { outcome: "nothing_to_release" } });
    expect(await stockOf(throwBlanket)).toBe(6);
  });
});
