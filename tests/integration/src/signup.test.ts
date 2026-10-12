import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { platformQuery } from "./db.ts";
import { baseDomain, routerPort, viaRouter } from "./router.ts";
import { compose, restartService, scaleService } from "./stack.ts";

/** The platform's own address: the bare base domain, served by the control plane's signup pages. */
const platformHost = `${baseDomain}:${routerPort}`;

const newHandle = () => `s-${randomUUID().slice(0, 8)}`;

interface SignupAnswer {
  status: number;
  body: { tenantId?: string; status?: string; statusUrl?: string; error?: string };
}

async function signup(fields: Partial<Record<"idempotencyKey" | "handle" | "name" | "password", string>>): Promise<SignupAnswer> {
  const res = await viaRouter(platformHost, "/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: randomUUID(), name: "A Test Shop", password: "a-long-enough-password", ...fields }),
  });
  return { status: res.status, body: JSON.parse(res.body) as SignupAnswer["body"] };
}

async function statusOf(tenantId: string): Promise<string> {
  const res = await viaRouter(platformHost, `/signups/${tenantId}`, { headers: { accept: "application/json" } });
  return (JSON.parse(res.body) as { status: string }).status;
}

const eventsOf = (tenantId: string) =>
  platformQuery<{ step: string; actor: string }>(
    "SELECT step, actor FROM platform.tenant_events WHERE tenant_id = $1 ORDER BY created_at",
    [tenantId],
  );

const stepCount = async (tenantId: string, step: string) =>
  (await eventsOf(tenantId)).filter((event) => event.step === step).length;

/** Polls until provisioning has checked the shop through the router (the last step). */
async function untilChecked(tenantId: string, timeout = 15_000): Promise<void> {
  await expect.poll(() => stepCount(tenantId, "checked"), { timeout, interval: 250 }).toBe(1);
}

describe("signup and provisioning", () => {
  it("turns a signup into a shop a buyer can order from, with no step outside the shop's own pages", async () => {
    const handle = newHandle();
    const password = `pw-${randomUUID()}`;
    const started = Date.now();
    const accepted = await signup({ handle, name: "Corner Books", password });
    expect(accepted).toMatchObject({ status: 202, body: { status: "PROVISIONING" } });
    const tenantId = accepted.body.tenantId!;

    await expect.poll(() => statusOf(tenantId), { timeout: 10_000, interval: 200 }).toBe("ACTIVE");
    expect(Date.now() - started).toBeLessThan(10_000);

    // The Merchant signs in with the password they chose and adds a product.
    const merchant = new Browser(handle);
    await expect
      .poll(async () => (await merchant.submit("/admin/session", { password })).headers.get("location"), { timeout: 10_000 })
      .toBe("/admin");
    const added = await merchant.submit("/admin/products", { name: "First Edition", priceMinor: "2500", stock: "3" });
    expect(added.status).toBe(303);

    // A buyer finds it on the shop's home page and checks out.
    const buyer = new Browser(handle);
    const home = await buyer.html("/");
    expect(home).toContain("Corner Books");
    const productId = home.match(/name="productId" value="([0-9a-f-]{36})"/)![1]!;
    await buyer.submit("/cart/items", { productId, action: "add" });
    const checkoutKey = (await buyer.html("/checkout")).match(/name="checkoutKey" value="([^"]+)"/)![1]!;
    const placed = await buyer.submit("/orders", { checkoutKey, paymentScenario: "approve" });
    const orderLink = placed.headers.get("location")!;
    await expect.poll(async () => (await buyer.html(orderLink)).includes("Confirmed"), { timeout: 15_000 }).toBe(true);

    // The audit trail, in order; failed router checks (before the router refreshed) may come between.
    await untilChecked(tenantId);
    const steps = (await eventsOf(tenantId)).filter((event) => event.step !== "check_failed");
    expect(steps.map((event) => `${event.step}:${event.actor}`)).toEqual([
      "created:signup",
      "placed:signup",
      "activated:platform-worker",
      "checked:platform-worker",
    ]);
  });

  it("walks a browser from the signup form to the new shop's sign-in page", async () => {
    const form = await viaRouter(platformHost, "/");
    expect(form.status).toBe(200);
    const idempotencyKey = form.body.match(/name="idempotencyKey" value="([^"]+)"/)![1]!;

    const handle = newHandle();
    const posted = await viaRouter(platformHost, "/signups", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://${platformHost}` },
      body: new URLSearchParams({ idempotencyKey, handle, name: "Form Shop", password: "a-long-enough-password" }).toString(),
    });
    expect(posted.status).toBe(303);
    const statusPage = String(posted.headers.location);
    expect(statusPage).toMatch(/^\/signups\/[0-9a-f-]{36}$/);

    await expect
      .poll(async () => (await viaRouter(platformHost, statusPage)).headers.location, { timeout: 10_000, interval: 250 })
      .toBe(`http://${handle}.${platformHost}/admin/login`);
  });

  it("refuses a signup form posted from another site", async () => {
    const res = await viaRouter(platformHost, "/signups", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" },
      body: new URLSearchParams({ idempotencyKey: randomUUID(), handle: newHandle(), name: "x", password: "a-long-enough-password" }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it("makes one shop from 20 concurrent retries of one signup, and refuses a changed retry", async () => {
    const idempotencyKey = randomUUID();
    const handle = newHandle();
    const answers = await Promise.all(Array.from({ length: 20 }, () => signup({ idempotencyKey, handle })));

    expect(new Set(answers.map((answer) => answer.status))).toEqual(new Set([202]));
    expect(new Set(answers.map((answer) => answer.body.tenantId)).size).toBe(1);
    const [row] = await platformQuery<{ n: number }>("SELECT count(*)::int AS n FROM platform.tenants WHERE handle = $1", [handle]);
    expect(row?.n).toBe(1);

    expect(await signup({ idempotencyKey, handle: newHandle() })).toMatchObject({ status: 409, body: { error: "signup_key_reused" } });
  });

  it.each([
    ["a taken handle", { handle: "harbor" }, 409, "handle_taken"],
    ["an invalid handle", { handle: "Not_A_Label" }, 422, "invalid_handle"],
    ["a too-short handle", { handle: "ab" }, 422, "invalid_handle"],
    ["a reserved handle", { handle: "admin" }, 422, "reserved_handle"],
    ["a short password", { password: "too-short" }, 422, "weak_password"],
    ["an empty name", { name: "   " }, 422, "invalid_name"],
  ])("refuses %s", async (_label, fields, status, error) => {
    expect(await signup({ handle: newHandle(), ...fields })).toMatchObject({ status, body: { error } });
  });

  describe("when the lifecycle worker stops and comes back", () => {
    afterAll(() => restartService("platform-worker"));

    it("resumes provisioning without repeating a step", async () => {
      compose("stop", "platform-worker");
      const handle = newHandle();
      const { body } = await signup({ handle });
      const tenantId = body.tenantId!;

      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await statusOf(tenantId)).toBe("PROVISIONING");
      expect((await viaRouter(`${handle}.${platformHost}`, "/")).status).toBe(503);

      restartService("platform-worker");
      await untilChecked(tenantId);
      expect(await statusOf(tenantId)).toBe("ACTIVE");
      for (const step of ["created", "placed", "activated", "checked"]) {
        expect.soft(await stepCount(tenantId, step), step).toBe(1);
      }
    });
  });

  describe("with two lifecycle workers", () => {
    afterAll(() => scaleService("platform-worker", 1));

    it("provisions each shop exactly once", async () => {
      scaleService("platform-worker", 2);
      const shops = await Promise.all(Array.from({ length: 6 }, () => signup({ handle: newHandle() })));
      for (const { body } of shops) {
        await untilChecked(body.tenantId!, 20_000);
        for (const step of ["placed", "activated", "checked"]) {
          expect.soft(await stepCount(body.tenantId!, step), step).toBe(1);
        }
      }
    });
  });
});
