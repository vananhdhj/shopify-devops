import { randomBytes, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CellRegistration } from "@shop/contracts";
import { platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { baseDomain, routerPort, viaRouter } from "./router.ts";
import { cellSecret, edgeCredentialsDir, platformCredentialsDir, secret } from "./secrets.ts";
import { tenants } from "./tenants.ts";

const platformHost = `${baseDomain}:${routerPort}`;

/** Pool-1's own registration, exactly as the stack's cell-register job sends it. */
const pool1: CellRegistration = {
  role: "pooled",
  capacity: 10_000,
  storefrontUrl: "http://storefront:3000",
  catalogUrl: "http://catalog-cart-api:4001",
  ordersUrl: "http://order-service:4002",
};

const register = (cell: string, body: unknown, token: string | null) =>
  fetch(`${platformInternalUrl}/internal/cells/${cell}/registration`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-platform-token": token } : {}) },
    body: JSON.stringify(body),
  });

const written: string[] = [];
/**
 * Gives the control plane and the edge a cell's secrets, as `make secrets` would; removed after the
 * file's tests.
 */
function giveCredentials(cell: string, values: { cellToken: string; storefrontToken: string; tenantContextSecret: string }): void {
  for (const [file, value] of [
    [`${platformCredentialsDir}/${cell}.platform-cell-token`, values.cellToken],
    [`${platformCredentialsDir}/${cell}.storefront-token`, values.storefrontToken],
    [`${edgeCredentialsDir}/${cell}.tenant-context-secret`, values.tenantContextSecret],
  ] as const) {
    writeFileSync(file, value, { mode: 0o644 });
    written.push(file);
  }
}

const randomSecrets = () => ({
  cellToken: randomBytes(24).toString("hex"),
  storefrontToken: randomBytes(24).toString("hex"),
  tenantContextSecret: randomBytes(24).toString("hex"),
});

/**
 * A throwaway cell (`test-…`) that is pool-1 under another name: pool-1's URLs and tokens, so a
 * shop placed in it is served, checked, and purged by pool-1's units. It tests the directory and
 * placement, not containment (two real cells do that, Phase 3 ticket 04).
 */
async function aliasCell(role: CellRegistration["role"], urls: Partial<CellRegistration> = {}): Promise<string> {
  const cell = `test-${randomUUID().slice(0, 8)}`;
  const cellToken = cellSecret("pool-1", "PLATFORM_CELL_TOKEN");
  giveCredentials(cell, {
    cellToken,
    storefrontToken: cellSecret("pool-1", "PLATFORM_STOREFRONT_TOKEN"),
    tenantContextSecret: cellSecret("pool-1", "TENANT_CONTEXT_SECRET"),
  });
  const res = await register(cell, { ...pool1, role, capacity: role === "dedicated" ? 1 : 100, ...urls }, cellToken);
  expect(res.status, await res.clone().text()).toBe(200);
  return cell;
}

/**
 * Takes every earlier run's test cell out of placement, so a free one cannot take this run's plus
 * signups. Their shops keep their rows; they only stop being placeable.
 */
const retireTestCells = () =>
  platformQuery(
    "UPDATE platform.cells SET registered_at = NULL, storefront_url = NULL, catalog_url = NULL, orders_url = NULL WHERE id LIKE 'test-%'",
  );

async function signup(plan: string, handle = `c-${randomUUID().slice(0, 8)}`) {
  const res = await viaRouter(platformHost, "/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name: `Cell Test ${handle}`, password: "a-long-enough-password", plan }),
  });
  return { status: res.status, handle, body: JSON.parse(res.body) as { tenantId?: string; error?: string } };
}

const tenantRow = async (id: string) =>
  (await platformQuery<{ cell: string | null; plan: string; status: string }>(
    "SELECT cell, plan, status FROM platform.tenants WHERE id = $1",
    [id],
  ))[0];

const stepCount = async (tenantId: string, step: string) =>
  (await platformQuery<{ n: number }>("SELECT count(*)::int AS n FROM platform.tenant_events WHERE tenant_id = $1 AND step = $2", [
    tenantId,
    step,
  ]))[0]!.n;

const operator = (path: string) =>
  fetch(`${platformInternalUrl}${path}`, { method: "POST", headers: { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") } });

/**
 * The stack's own dedicated cell (dedicated-1, with CELLS=2) is set aside while this file runs, so
 * the placement tests see only the dedicated cells they register; restored afterwards as it was.
 */
let setAside: { id: string; registered_at: Date }[] = [];
beforeAll(async () => {
  await retireTestCells();
  setAside = await platformQuery(
    "SELECT id, registered_at FROM platform.cells WHERE role = 'dedicated' AND id NOT LIKE 'test-%' AND registered_at IS NOT NULL",
  );
  await platformQuery("UPDATE platform.cells SET registered_at = NULL WHERE id = ANY($1)", [setAside.map((cell) => cell.id)]);
});
afterAll(async () => {
  await retireTestCells();
  for (const cell of setAside) {
    await platformQuery("UPDATE platform.cells SET registered_at = $2 WHERE id = $1", [cell.id, cell.registered_at]);
  }
  for (const file of written) rmSync(file, { force: true });
});

describe("cell registration", () => {
  it("enters a cell only with that cell's own token", async () => {
    expect((await register("pool-1", pool1, null)).status).toBe(401);
    expect((await register("pool-1", pool1, "not-the-token")).status).toBe(401);

    // A cell the control plane has a token for cannot be registered with another cell's token.
    const other = `test-${randomUUID().slice(0, 8)}`;
    giveCredentials(other, randomSecrets());
    expect((await register(other, pool1, cellSecret("pool-1", "PLATFORM_CELL_TOKEN"))).status).toBe(401);
    // Nor can a cell the control plane holds no secrets for, whatever the token.
    expect((await register(`test-${randomUUID().slice(0, 8)}`, pool1, cellSecret("pool-1", "PLATFORM_CELL_TOKEN"))).status).toBe(401);

    const cells = await platformQuery<{ id: string }>("SELECT id FROM platform.cells WHERE id = $1", [other]);
    expect(cells).toEqual([]);
  });

  it("registers again without change, and refuses to change the role of a cell holding shops", async () => {
    const token = cellSecret("pool-1", "PLATFORM_CELL_TOKEN");
    expect((await register("pool-1", pool1, token)).status).toBe(200);
    expect((await register("pool-1", { ...pool1, role: "canary" }, token)).status).toBe(409);
    expect((await register("pool-1", { ...pool1, capacity: 1 }, token)).status).toBe(409);
    expect((await register("pool-1", { ...pool1, storefrontUrl: "not a url" }, token)).status).toBe(400);

    const [row] = await platformQuery<{ role: string; capacity: number }>("SELECT role, capacity FROM platform.cells WHERE id = 'pool-1'");
    expect(row).toEqual({ role: "pooled", capacity: 10_000 });
  });
});

describe("placement by plan", () => {
  it("places a starter shop in the pooled cell at signup", async () => {
    const { status, body } = await signup("starter");
    expect(status).toBe(202);
    expect(await tenantRow(body.tenantId!)).toMatchObject({ cell: "pool-1", plan: "starter" });
  });

  it("refuses a plus shop when no dedicated cell is free, and writes nothing", async () => {
    const { status, handle, body } = await signup("plus");
    expect({ status, error: body.error }).toEqual({ status: 409, error: "no_capacity" });
    expect(await platformQuery("SELECT id FROM platform.tenants WHERE handle = $1", [handle])).toEqual([]);
  });

  it("gives a plus shop a free dedicated cell of its own, where it is served, and refuses the next", async () => {
    const cell = await aliasCell("dedicated");
    const { status, handle, body } = await signup("plus");
    expect(status).toBe(202);
    expect(await tenantRow(body.tenantId!)).toMatchObject({ cell, plan: "plus" });
    await expect.poll(() => stepCount(body.tenantId!, "checked"), { timeout: 15_000, interval: 250 }).toBe(1);
    expect((await viaRouter(`${handle}.${platformHost}`, "/")).body).toContain(`Cell Test ${handle}`);

    expect(await signup("plus")).toMatchObject({ status: 409, body: { error: "no_capacity" } });
  });

  it("places exactly one of several plus signups racing for the last dedicated cell", async () => {
    const cell = await aliasCell("dedicated");
    const answers = await Promise.all(Array.from({ length: 6 }, () => signup("plus")));
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409, 409, 409, 409, 409]);
    const [placed] = await platformQuery<{ n: number }>("SELECT count(*)::int AS n FROM platform.tenants WHERE cell = $1", [cell]);
    expect(placed?.n).toBe(1);
  });

  it("holds an internal shop until a canary cell registers, then places and activates it there", async () => {
    const handle = `i-${randomUUID().slice(0, 8)}`;
    const [shop] = await platformQuery<{ id: string }>(
      "INSERT INTO platform.tenants (handle, name, merchant_password_hash, internal) VALUES ($1, $1, 'scrypt:00:00', true) RETURNING id",
      [handle],
    );
    await platformQuery("INSERT INTO platform.lifecycle_outbox (tenant_id, action) VALUES ($1, 'provision')", [shop!.id]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await tenantRow(shop!.id)).toMatchObject({ cell: null, status: "PROVISIONING" });

    const cell = await aliasCell("canary");
    await expect.poll(async () => (await tenantRow(shop!.id))?.status, { timeout: 30_000, interval: 250 }).toBe("ACTIVE");
    expect((await tenantRow(shop!.id))?.cell).toBe(cell);
  });
});

describe("a shop's cell, for the control plane's calls into cells", () => {
  it("purges a deleted shop through the APIs of the cell holding it", async () => {
    // A dedicated cell whose orders API cannot be reached: the deletion waits on it.
    const cell = await aliasCell("dedicated", { ordersUrl: "http://nowhere.invalid:4002" });
    const { body } = await signup("plus");
    expect(await tenantRow(body.tenantId!)).toMatchObject({ cell });
    await expect.poll(async () => (await tenantRow(body.tenantId!))?.status, { timeout: 15_000, interval: 250 }).toBe("ACTIVE");
    const handle = (await platformQuery<{ handle: string }>("SELECT handle FROM platform.tenants WHERE id = $1", [body.tenantId!]))[0]!.handle;

    expect((await operator(`/operator/tenants/${handle}/delete`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await stepCount(body.tenantId!, "purged")).toBe(0);
    expect((await tenantRow(body.tenantId!))?.status).toBe("DELETING");

    // The cell registers again with a reachable API; the retried deletion finishes there.
    expect((await register(cell, { ...pool1, role: "dedicated", capacity: 1 }, cellSecret("pool-1", "PLATFORM_CELL_TOKEN"))).status).toBe(200);
    await expect.poll(async () => (await tenantRow(body.tenantId!))?.status, { timeout: 60_000, interval: 500 }).toBe("DELETED");
  }, 90_000);

  it("checks a Merchant sign-in only for the storefront of the shop's cell", async () => {
    const other = `test-${randomUUID().slice(0, 8)}`;
    const secrets = randomSecrets();
    giveCredentials(other, secrets);
    const check = (token: string) =>
      fetch(`${platformInternalUrl}/internal/merchant-sign-ins`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-platform-token": token },
        body: JSON.stringify({ tenantId: tenants.harbor.id, password: secret("MERCHANT_PASSWORD_HARBOR") }),
      });

    expect((await check(secrets.storefrontToken)).status).toBe(401);
    expect(await (await check(cellSecret("pool-1", "PLATFORM_STOREFRONT_TOKEN"))).json()).toEqual({ ok: true, credentialVersion: 1 });
  });
});

describe("the fleet view", () => {
  interface CellView {
    id: string;
    role: string;
    capacity: number;
    registeredAt: string | null;
    shops: Record<string, number>;
    placed: number;
    apis: { catalog: string; orders: string } | null;
  }
  const fleet = async () => {
    const res = await fetch(`${platformInternalUrl}/operator/cells`, { headers: { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { cells: CellView[] }).cells;
  };
  const viewOf = async (cell: string) => (await fleet()).find((view) => view.id === cell);
  const noShops = { PROVISIONING: 0, ACTIVE: 0, SUSPENDED: 0, DELETING: 0, DELETED: 0 };

  it("is for the platform operator only", async () => {
    expect((await fetch(`${platformInternalUrl}/operator/cells`)).status).toBe(401);
    expect((await fetch(`${platformInternalUrl}/operator/cells`, { headers: { "x-operator-token": "not-the-token" } })).status).toBe(401);
  });

  it("counts each cell's shops and asks each cell's APIs whether they are ready, without failing on one that is down", async () => {
    // A dedicated cell whose orders API cannot be reached, the only one free (an earlier test's
    // cell is free again once its shop is deleted).
    await retireTestCells();
    const cell = await aliasCell("dedicated", { ordersUrl: "http://nowhere.invalid:4002" });
    expect(await viewOf(cell)).toEqual({
      id: cell,
      role: "dedicated",
      capacity: 1,
      registeredAt: expect.any(String),
      shops: noShops,
      placed: 0,
      apis: { catalog: "ready", orders: "unreachable" },
    });

    const { body } = await signup("plus");
    expect(await tenantRow(body.tenantId!)).toMatchObject({ cell });
    await expect.poll(async () => (await tenantRow(body.tenantId!))?.status, { timeout: 15_000, interval: 250 }).toBe("ACTIVE");
    expect(await viewOf(cell)).toMatchObject({ shops: { ...noShops, ACTIVE: 1 }, placed: 1 });

    // pool-1 counts every shop placed in it that is not deleted, and its APIs are ready.
    const [pool] = await platformQuery<{ n: number }>("SELECT count(*)::int AS n FROM platform.tenants WHERE cell = 'pool-1' AND status <> 'DELETED'");
    expect(await viewOf("pool-1")).toMatchObject({ role: "pooled", placed: pool!.n, apis: { catalog: "ready", orders: "ready" } });
    expect((await viewOf("pool-1"))!.shops.ACTIVE).toBeGreaterThanOrEqual(2);

    // A cell taken out of the directory is listed, unregistered, and not asked.
    await retireTestCells();
    expect(await viewOf(cell)).toMatchObject({ registeredAt: null, apis: null, placed: 1 });
  });
});
