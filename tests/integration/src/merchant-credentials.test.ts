import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { secret } from "./secrets.ts";
import { compose, restartService } from "./stack.ts";
import { tenants } from "./tenants.ts";

const signInCheck = (body: unknown, token: string | null = secret("PLATFORM_STOREFRONT_TOKEN")) =>
  fetch(`${platformInternalUrl}/internal/merchant-sign-ins`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-platform-token": token } : {}) },
    body: JSON.stringify(body),
  });

/** An active shop in the registry with a password the test knows; no rows in the cell. */
async function shopWithPassword(): Promise<{ id: string; handle: string; password: string }> {
  const handle = `t-${randomUUID().slice(0, 8)}`;
  const password = `pw-${randomUUID()}`;
  const salt = randomBytes(16);
  const hash = `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
  const [row] = await platformQuery<{ id: string }>(
    "INSERT INTO platform.tenants (handle, name, merchant_password_hash) VALUES ($1, $1, $2) RETURNING id",
    [handle, hash],
  );
  await platformQuery("UPDATE platform.tenants SET status = 'ACTIVE', cell = 'cell-1' WHERE id = $1", [row!.id]);
  return { id: row!.id, handle, password };
}

/** Signs in through the router, retrying while the router has not yet picked up a new shop. */
async function signIn(handle: string, password: string): Promise<Browser> {
  const browser = new Browser(handle);
  await expect
    .poll(async () => (await browser.submit("/admin/session", { password })).headers.get("location"), { timeout: 10_000 })
    .toBe("/admin");
  return browser;
}

describe("Merchant credentials in the control plane", () => {
  it("checks a sign-in only for a caller with the storefront token, and answers only yes or no", async () => {
    expect((await signInCheck({ tenantId: tenants.harbor.id, password: "x" }, null)).status).toBe(401);

    const right = await signInCheck({ tenantId: tenants.harbor.id, password: secret("MERCHANT_PASSWORD_HARBOR") });
    expect(await right.json()).toEqual({ ok: true, credentialVersion: 1 });
    const wrong = await signInCheck({ tenantId: tenants.harbor.id, password: secret("MERCHANT_PASSWORD_MEADOW") });
    expect(await wrong.json()).toEqual({ ok: false });
    const unknown = await signInCheck({ tenantId: randomUUID(), password: "anything-at-all" });
    expect(await unknown.json()).toEqual({ ok: false });
  });

  it("signs a shop's sessions out when its credential version changes", async () => {
    const shop = await shopWithPassword();
    const merchant = await signIn(shop.handle, shop.password);
    expect((await merchant.get("/admin")).status).toBe(200);

    await platformQuery("UPDATE platform.tenants SET credential_version = credential_version + 1 WHERE id = $1", [shop.id]);
    await expect.poll(async () => (await merchant.get("/admin")).status, { timeout: 10_000, interval: 250 }).toBe(307);

    // A fresh sign-in works again, bound to the new version.
    const again = await signIn(shop.handle, shop.password);
    expect((await again.get("/admin")).status).toBe(200);
  });

  it("refuses sign-in to a suspended shop", async () => {
    const shop = await shopWithPassword();
    await platformQuery("UPDATE platform.tenants SET status = 'SUSPENDED' WHERE id = $1", [shop.id]);
    expect(await (await signInCheck({ tenantId: shop.id, password: shop.password })).json()).toEqual({ ok: false });
  });

  describe("while the control plane is down", () => {
    afterEach(() => restartService("platform-api"));

    it("keeps existing sessions working and makes new sign-ins say so", async () => {
      const merchant = await signIn("harbor", secret("MERCHANT_PASSWORD_HARBOR"));
      compose("stop", "platform-api");

      expect((await merchant.get("/admin")).status).toBe(200);
      const fresh = await new Browser("harbor").submit("/admin/session", { password: secret("MERCHANT_PASSWORD_HARBOR") });
      expect(fresh.headers.get("location")).toBe("/admin/login?error=unavailable");
      expect(await new Browser("harbor").html("/admin/login?error=unavailable")).toContain("isn&#x27;t possible right now");
    });
  });
});
