import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Checksums, shopChecksums } from "./cell-data.ts";
import { cellQuery, platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { shopFetch } from "./router.ts";
import { type Event, type Shop, deleteShop, eventsOf, operatorHeaders, ordersIn, placeOrder, starterShop, tenantOf, waitUntil } from "./shops.ts";
import { compose } from "./stack.ts";
import { tenants } from "./tenants.ts";

/**
 * Phase 6's per-tenant exports and restores (decision 3): the platform worker exports every ACTIVE
 * shop to its volume (Compose: every 15 minutes, looked for every 2 s), and the operator restores a
 * shop to one export. A fresh starter shop in pool-1; deleted after, with its exports.
 */
interface ExportSummary {
  id: string;
  kind: string;
  takenAt: string;
  rows: Record<string, number>;
}

async function exportsOf(handle: string): Promise<ExportSummary[]> {
  const res = await fetch(`${platformInternalUrl}/operator/tenants/${handle}/exports`, { headers: operatorHeaders });
  expect(res.status).toBe(200);
  return ((await res.json()) as { exports: ExportSummary[] }).exports;
}

const restore = (handle: string, exportId: string) =>
  fetch(`${platformInternalUrl}/operator/tenants/${handle}/restore`, {
    method: "POST",
    headers: { ...operatorHeaders, "content-type": "application/json" },
    body: JSON.stringify({ export: exportId }),
  });

/** An on-demand export, once written. */
async function exportNow(handle: string): Promise<ExportSummary> {
  const before = (await exportsOf(handle)).length;
  expect((await fetch(`${platformInternalUrl}/operator/tenants/${handle}/exports`, { method: "POST", headers: operatorHeaders })).status).toBe(202);
  await waitUntil(`${handle}'s export is written`, async () => (await exportsOf(handle)).length > before, 20_000, 250);
  const newest = (await exportsOf(handle))[0]!;
  expect(newest.kind).toBe("on-demand");
  return newest;
}

/** The steps of a shop's latest restore, from its request on (only the restore's own steps). */
const latestRestore = (events: Event[]) => events.slice(events.map((e) => e.step).lastIndexOf("restore")).filter((e) => e.step.startsWith("restore"));

/** Follows a shop's latest restore until it ends; returns its events. */
async function restoreEnds(handle: string) {
  await waitUntil(
    `${handle}'s restore ends`,
    async () => latestRestore(await eventsOf(handle)).some((e) => e.step === "restored" || e.step === "restore_undone" || e.step === "restore_failed"),
    60_000,
    250,
  );
  await waitUntil(`${handle} is ACTIVE`, async () => (await tenantOf((await platformQuery<{ id: string }>("SELECT id FROM platform.tenants WHERE handle = $1", [handle]))[0]!.id))?.status === "ACTIVE", 30_000, 250);
  return latestRestore(await eventsOf(handle));
}

const fileOf = async (exportId: string) =>
  (await platformQuery<{ file: string }>("SELECT file FROM platform.tenant_exports WHERE id = $1", [exportId]))[0]!.file;

const productNames = async (tenantId: string) =>
  (await cellQuery<{ name: string }>("pool-1", "SELECT name FROM catalog.products WHERE tenant_id = $1 ORDER BY name", [tenantId])).map((p) => p.name);

describe("tenant exports and restore", () => {
  let shop: Shop;
  let products: string[];

  beforeAll(async () => {
    ({ shop, products } = await starterShop("rs", ["Restore Bowl", "Restore Cup", "Restore Plate"]));
    // One settled Order before any export.
    const first = await placeOrder(shop.handle, products[0]!, "approve");
    await waitUntil("the first Order settles", async () => (await ordersIn("pool-1", shop.id)).find((o) => o.id === first)?.status === "CONFIRMED", 20_000, 250);
  }, 120_000);

  afterAll(async () => {
    if (shop) await deleteShop(shop);
  }, 120_000);

  it("exports a new ACTIVE shop on its schedule, to the worker's volume", async () => {
    await waitUntil(`${shop.handle} has a scheduled export`, async () => (await exportsOf(shop.handle)).some((e) => e.kind === "scheduled"), 20_000, 500);
    const scheduled = (await exportsOf(shop.handle)).find((e) => e.kind === "scheduled")!;
    // Taken as soon as the shop was ACTIVE, possibly before its Merchant added a product.
    expect(Object.keys(scheduled.rows).sort()).toEqual([
      "catalog.cart_items", "catalog.carts", "catalog.inventory_effects", "catalog.products",
      "orders.order_events", "orders.order_items", "orders.orders", "orders.outbox",
    ]);
    const file = await fileOf(scheduled.id);
    expect(compose("exec", "-T", "platform-worker", "ls", `/exports/${file}`).trim()).toBe(`/exports/${file}`);
  });

  it("restores products deleted after an export, losing what changed since, and leaves another shop's rows alone", async () => {
    const chosen = await exportNow(shop.handle);
    expect(chosen.rows).toMatchObject({ "catalog.products": 3, "orders.orders": 1 });
    const meadowBefore = await shopChecksums("pool-1", tenants.meadow.id);

    // After the export: an Order (lost by the restore, as stated), then the mistake, two products deleted.
    const lost = await placeOrder(shop.handle, products[0]!, "approve");
    await expect.poll(async () => (await ordersIn("pool-1", shop.id)).find((o) => o.id === lost)?.status, { timeout: 20_000 }).toBe("CONFIRMED");
    await cellQuery("pool-1", "DELETE FROM catalog.products WHERE tenant_id = $1 AND id = ANY($2)", [shop.id, products.slice(1)]);
    expect(await productNames(shop.id)).toEqual(["Restore Bowl"]);

    const asked = await restore(shop.handle, chosen.id);
    expect(asked.status).toBe(202);
    expect(await asked.json()).toMatchObject({ status: "RESTORING", takenAt: chosen.takenAt, warning: expect.stringContaining("is lost") });
    const events = await restoreEnds(shop.handle);
    expect(events.map((e) => e.step)).toEqual(["restore", "restore_drained", "restore_saved", "restored"]);
    const restored = events.at(-1)!;
    expect(restored.toStatus).toBe("ACTIVE");
    expect(restored.detail.frozenMs as number).toBeLessThan(30_000);

    // The shop is as it was at the export, every table's count and checksum.
    expect(await productNames(shop.id)).toEqual(["Restore Bowl", "Restore Cup", "Restore Plate"]);
    expect(await shopChecksums("pool-1", shop.id)).toEqual(restored.detail.checksums as Checksums);
    expect((await ordersIn("pool-1", shop.id)).map((o) => o.id)).not.toContain(lost);
    expect(await shopChecksums("pool-1", tenants.meadow.id)).toEqual(meadowBefore);
    expect(await (await shopFetch("/", {}, shop.handle)).text()).toContain("Restore Plate");

    // The shop as it was just before the restore is kept as a pre-restore export.
    const saved = (await exportsOf(shop.handle)).find((e) => e.kind === "pre-restore")!;
    expect(saved.rows).toMatchObject({ "catalog.products": 1, "orders.orders": 2 });
  }, 120_000);

  it("puts the shop back as it was when the export cannot be read", async () => {
    const chosen = await exportNow(shop.handle);
    const file = await fileOf(chosen.id);
    compose("exec", "-T", "platform-worker", "rm", `/exports/${file}`);
    const before = await shopChecksums("pool-1", shop.id);

    expect((await restore(shop.handle, chosen.id)).status).toBe(202);
    const steps = (await restoreEnds(shop.handle)).map((e) => e.step);
    expect(steps).toEqual(["restore", "restore_drained", "restore_saved", "restore_failed", "restore_undone"]);
    expect(await shopChecksums("pool-1", shop.id)).toEqual(before);
  }, 120_000);

  it("refuses an unknown export, another shop's export, and a shop that is not ACTIVE", async () => {
    const mine = (await exportsOf(shop.handle))[0]!;
    expect((await restore(shop.handle, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await restore("meadow", mine.id)).status).toBe(404);
    expect((await restore("no-such-shop", mine.id)).status).toBe(404);
    expect((await restore("synthetic-pool-1", mine.id)).status).toBe(409);
    expect((await restore(shop.handle, "not-an-id")).status).toBe(400);
  });

  it("forgets a deleted shop's exports, files and records", async () => {
    const files = (await platformQuery<{ file: string }>("SELECT file FROM platform.tenant_exports WHERE tenant_id = $1", [shop.id])).map((r) => r.file);
    expect(files.length).toBeGreaterThan(0);
    await deleteShop(shop);
    await waitUntil("the exports are forgotten", async () => (await platformQuery("SELECT 1 FROM platform.tenant_exports WHERE tenant_id = $1", [shop.id])).length === 0, 20_000, 500);
    expect(compose("exec", "-T", "platform-worker", "sh", "-c", `test -e /exports/${shop.id} && echo present || echo gone`).trim()).toBe("gone");
    shop = undefined as unknown as Shop;
  }, 120_000);
});
