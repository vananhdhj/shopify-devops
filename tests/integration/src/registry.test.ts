import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TenantRouteTable } from "@shop/contracts";
import { platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { shopFetch, viaRouter } from "./router.ts";
import { secret } from "./secrets.ts";
import { compose, restartService } from "./stack.ts";
import { tenants } from "./tenants.ts";

const routes = (token: string | null = secret("PLATFORM_ROUTER_TOKEN")) =>
  fetch(`${platformInternalUrl}/internal/routes`, { headers: token ? { "x-platform-token": token } : {} });

/** A shop entered straight into the registry, as provisioning will (ticket 03); random handle, no rows in the cell. */
async function registryShop(): Promise<{ id: string; handle: string; name: string }> {
  const handle = `t-${randomUUID().slice(0, 8)}`;
  const name = `Registry Test ${handle}`;
  const [row] = await platformQuery<{ id: string }>(
    "INSERT INTO platform.tenants (handle, name, merchant_password_hash) VALUES ($1, $2, 'scrypt:00:00') RETURNING id",
    [handle, name],
  );
  return { id: row!.id, handle, name };
}

const setStatus = (id: string, status: string) =>
  platformQuery("UPDATE platform.tenants SET status = $2 WHERE id = $1", [id, status]);

/** What the router answers for a shop, polled until it matches (the table refreshes every 2 s). */
async function expectPage(handle: string, status: number, text: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await shopFetch("/", {}, handle);
        return { status: res.status, hasText: (await res.text()).includes(text) };
      },
      { timeout: 10_000, interval: 250 },
    )
    .toEqual({ status, hasText: true });
}

describe("tenant registry", () => {
  it("serves the routing table only to a caller with the router token", async () => {
    expect((await routes(null)).status).toBe(401);
    expect((await routes("not-the-token")).status).toBe(401);

    const table = (await (await routes()).json()) as TenantRouteTable;
    for (const tenant of [tenants.harbor, tenants.meadow]) {
      expect(table.tenants).toContainEqual({ ...tenant, status: "ACTIVE", credentialVersion: 1, cell: "pool-1" });
    }
    expect(table.cells).toContainEqual({ id: "pool-1", storefrontUrl: "http://storefront:3000" });
  });

  it("routes a shop by its registry status: being set up, active, suspended, being deleted, deleted", async () => {
    const shop = await registryShop();
    await expectPage(shop.handle, 503, "being set up");

    await setStatus(shop.id, "ACTIVE");
    await expectPage(shop.handle, 200, shop.name);

    await setStatus(shop.id, "SUSPENDED");
    await expectPage(shop.handle, 503, "temporarily unavailable");

    await setStatus(shop.id, "DELETING");
    await expectPage(shop.handle, 404, "No shop at this address.");

    await setStatus(shop.id, "DELETED");
    await expectPage(shop.handle, 404, "No shop at this address.");
  });

  it("refuses illegal lifecycle moves in the database itself", async () => {
    const shop = await registryShop();
    await expect(setStatus(shop.id, "DELETED")).rejects.toMatchObject({ code: "23514" });
    await expect(
      platformQuery(
        "INSERT INTO platform.tenants (handle, name, status, merchant_password_hash) VALUES ($1, 'x', 'ACTIVE', 'x')",
        [`t-${randomUUID().slice(0, 8)}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("records the seeded shops' history", async () => {
    const events = await platformQuery<{ step: string; to_status: string; actor: string }>(
      "SELECT step, to_status, actor FROM platform.tenant_events WHERE tenant_id = $1 ORDER BY created_at",
      [tenants.harbor.id],
    );
    expect(events).toEqual([
      { step: "created", to_status: "PROVISIONING", actor: "seed" },
      { step: "activated", to_status: "ACTIVE", actor: "seed" },
    ]);
  });

  describe("while the control plane is down", () => {
    afterEach(() => restartService("platform-api"));

    it("keeps serving existing shops from the router's cached table", async () => {
      compose("stop", "platform-api");
      // Longer than several refresh intervals: every refresh in between fails.
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      for (const handle of ["harbor", "meadow"]) {
        expect((await shopFetch("/", {}, handle)).status).toBe(200);
      }
      const metrics = compose("exec", "-T", "router", "wget", "-qO-", "http://127.0.0.1:8001/metrics");
      expect(metrics).toMatch(/^router_routes_refresh_failures_total [1-9]/m);
      expect(compose("exec", "-T", "router", "wget", "-qO-", "http://127.0.0.1:8001/health/ready")).toContain("ready");
    });

    it("answers a signup at the platform address with a clean 503", async () => {
      compose("stop", "platform-api");
      const res = await viaRouter("shop.localhost:8000", "/signups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID(), handle: "x-outage", name: "x", password: "a-long-enough-password" }),
      });
      expect(res.status).toBe(503);
      expect(res.body).toBe("This service is temporarily unavailable. Try again in a few seconds.\n");
    });

    it("brings a restarted router back ready on the table it saved", async () => {
      compose("stop", "platform-api");
      // Same container, so the table it saved in /tmp is still there; the control plane is not.
      compose("restart", "router");
      await expect
        .poll(async () => (await shopFetch("/", {}, "harbor")).status, { timeout: 30_000, interval: 500 })
        .toBe(200);
      expect((await shopFetch("/", {}, "meadow")).status).toBe(200);
      expect(compose("logs", "--no-log-prefix", "--since", "1m", "router")).toContain("serving the saved routing table");
    });
  });
});
