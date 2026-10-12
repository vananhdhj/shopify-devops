import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { platformQuery } from "./db.ts";
import { shopFetch } from "./router.ts";
import { cellSecret, edgeCredentialsDir } from "./secrets.ts";
import { compose } from "./stack.ts";

const written: string[] = [];
const cells: string[] = [];
afterAll(async () => {
  for (const file of written) rmSync(file, { force: true });
  // Out of placement, so no later signup lands in a cell that is pool-1 under another name.
  await platformQuery("UPDATE platform.cells SET registered_at = NULL WHERE id = ANY($1)", [cells]);
});

/**
 * A cell entered straight into the directory: pool-1's storefront under another id, as a full-sized
 * canary of one, so placement never picks it for anything but the shop the test puts in it.
 */
async function directoryCell(registered: boolean): Promise<string> {
  const cell = `test-${randomUUID().slice(0, 8)}`;
  cells.push(cell);
  await platformQuery(
    `INSERT INTO platform.cells (id, role, capacity, storefront_url, catalog_url, orders_url, registered_at)
     VALUES ($1, 'canary', 1, 'http://storefront:3000', 'http://catalog-cart-api:4001', 'http://order-service:4002',
             CASE WHEN $2 THEN now() END)`,
    [cell, registered],
  );
  return cell;
}

function giveEdgeSecret(cell: string, secret: string): void {
  const file = `${edgeCredentialsDir}/${cell}.tenant-context-secret`;
  writeFileSync(file, secret, { mode: 0o644 });
  written.push(file);
}

/** An active shop placed straight into `cell`, with no rows anywhere. */
async function shopIn(cell: string): Promise<{ handle: string; name: string }> {
  const handle = `e-${randomUUID().slice(0, 8)}`;
  const name = `Edge Test ${handle}`;
  const [row] = await platformQuery<{ id: string }>(
    "INSERT INTO platform.tenants (handle, name, merchant_password_hash, cell) VALUES ($1, $2, 'scrypt:00:00', $3) RETURNING id",
    [handle, name, cell],
  );
  await platformQuery("UPDATE platform.tenants SET status = 'ACTIVE' WHERE id = $1", [row!.id]);
  return { handle, name };
}

/** The edge's answer for a shop, polled while the edge picks up the new table (2 s refresh). */
const answerFor = (handle: string, text: string) =>
  expect.poll(
    async () => {
      const res = await shopFetch("/", {}, handle);
      return { status: res.status, hasText: (await res.text()).includes(text) };
    },
    { timeout: 10_000, interval: 250 },
  );

const edgeMetrics = () => compose("exec", "-T", "edge", "wget", "-qO-", "http://127.0.0.1:8001/metrics");

describe("the edge", () => {
  it("sends a shop to its own cell's storefront, signed with that cell's secret", async () => {
    const cell = await directoryCell(true);
    giveEdgeSecret(cell, cellSecret("pool-1", "TENANT_CONTEXT_SECRET"));
    const shop = await shopIn(cell);
    await answerFor(shop.handle, shop.name).toEqual({ status: 200, hasText: true });
    expect(edgeMetrics()).toMatch(new RegExp(`^router_proxied_requests_total\\{cell="${cell}"\\} [1-9]`, "m"));
  });

  it("answers 503 for a shop whose cell has not registered, and never serves it from another cell", async () => {
    const cell = await directoryCell(false);
    giveEdgeSecret(cell, cellSecret("pool-1", "TENANT_CONTEXT_SECRET"));
    const shop = await shopIn(cell);
    await answerFor(shop.handle, "temporarily unavailable").toEqual({ status: 503, hasText: true });
    expect(edgeMetrics()).toMatch(/^router_unroutable_requests_total\{reason="unknown_cell"\} [1-9]/m);
  });

  it("answers 503 for a shop whose cell's secret the edge does not hold", async () => {
    const shop = await shopIn(await directoryCell(true));
    await answerFor(shop.handle, "temporarily unavailable").toEqual({ status: 503, hasText: true });
    expect(edgeMetrics()).toMatch(/^router_unroutable_requests_total\{reason="no_secret"\} [1-9]/m);
  });

  it("gets nothing from a storefront that does not hold the secret the context was signed with", async () => {
    // The edge signs for this cell with a secret pool-1's storefront does not know: as if the
    // directory sent one cell's shop to another cell, the storefront refuses it.
    const cell = await directoryCell(true);
    giveEdgeSecret(cell, randomBytes(24).toString("hex"));
    const shop = await shopIn(cell);
    await answerFor(shop.handle, "No shop at this address.").toEqual({ status: 404, hasText: true });
  });
});
