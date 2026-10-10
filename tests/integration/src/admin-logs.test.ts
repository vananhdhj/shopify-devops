import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { secret } from "./secrets.ts";
import { compose } from "./stack.ts";

describe("admin credentials in logs", () => {
  it("never logs the Merchant's password, session cookie, or the admin service token", async () => {
    const merchant = new Browser();
    await merchant.submit("/admin/session", { password: secret("ADMIN_PASSWORD") });
    const session = merchant.cookie.split("=")[1]!;
    await merchant.html("/admin");
    await merchant.submit("/admin/products", { name: `Log Probe ${Date.now()}`, priceMinor: "100", stock: "1" });
    // Generated, so no password-shaped literal lives in the repository.
    const wrongGuess = `wrong-${randomUUID()}`;
    await new Browser().submit("/admin/session", { password: wrongGuess });

    const logs = compose("logs", "--no-log-prefix", "--since", "2m", "storefront", "catalog-cart-api", "order-service");
    expect(logs).not.toContain(secret("ADMIN_PASSWORD"));
    expect(logs).not.toContain(wrongGuess);
    expect(logs).not.toContain(secret("ADMIN_SERVICE_TOKEN"));
    expect(logs).not.toContain(session);
  });
});
