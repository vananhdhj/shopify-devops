import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planLimits } from "@shop/tenancy";
import { RateLimiter } from "../../../apps/router/src/rate-limit.ts";
import { platformQuery } from "./db.ts";
import { baseDomain, routerPort, shopHost, viaRouter } from "./router.ts";
import { compose } from "./stack.ts";

describe("the token bucket (pure)", () => {
  const limit = { rate: 10, burst: 30 };

  it("lets a burst through, then the sustained rate, and says when to come back", () => {
    const limiter = new RateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i++) expect(limiter.take("a", limit, t0)).toEqual({ allowed: true });
    expect(limiter.take("a", limit, t0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    // 100 ms at 10 a second is one token.
    expect(limiter.take("a", limit, t0 + 100)).toEqual({ allowed: true });
    expect(limiter.take("a", limit, t0 + 100).allowed).toBe(false);
    // Each key has its own bucket.
    expect(limiter.take("b", limit, t0 + 100)).toEqual({ allowed: true });
  });

  it("refills to the burst and no further, and forgets idle buckets", () => {
    const limiter = new RateLimiter(60_000);
    for (let i = 0; i < 30; i++) limiter.take("a", limit, 0);
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (limiter.take("a", limit, 3_600_000).allowed) allowed++;
    expect(allowed).toBe(30);
    limiter.sweep(3_600_000 + 60_001);
    expect(limiter.size).toBe(0);
  });

  it("never limits an unlimited class", () => {
    const limiter = new RateLimiter();
    const unlimited = { rate: planLimits.internal.requestsPerSecond, burst: planLimits.internal.burst };
    for (let i = 0; i < 1_000; i++) expect(limiter.take("synthetic", unlimited, 0).allowed).toBe(true);
  });
});

describe("the edge's rate quota", () => {
  it("answers a starter shop past its burst with 429 and Retry-After, never reaching the cell, while other shops keep 200", async () => {
    const handle = `rl-${randomUUID().slice(0, 8)}`;
    const res = await viaRouter(`${baseDomain}:${routerPort}`, "/signups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: randomUUID(), handle, name: "Rate Quota", password: "a-long-enough-password", plan: "starter" }),
    });
    const tenantId = (JSON.parse(res.body) as { tenantId: string }).tenantId;
    await expect
      .poll(async () => (await platformQuery<{ status: string }>("SELECT status FROM platform.tenants WHERE id = $1", [tenantId]))[0]?.status, {
        timeout: 30_000,
      })
      .toBe("ACTIVE");
    // Wait out the provisioning check's requests, so the bucket is full.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const { burst } = planLimits.starter;
    const answers = await Promise.all(Array.from({ length: burst * 2 }, () => viaRouter(shopHost(handle), "/healthz")));
    const refused = answers.filter((answer) => answer.status === 429);
    // At least the excess over the burst (a few tokens refill while the requests are in flight).
    expect(refused.length).toBeGreaterThanOrEqual(burst - 5);
    expect(answers.every((answer) => answer.status === 200 || answer.status === 429)).toBe(true);
    expect(refused[0]!.headers["retry-after"]).toMatch(/^[1-9]\d*$/);
    expect(refused[0]!.body).toMatch(/^Too many requests to this shop\. Try again in \d+ s\./);

    // Another shop is not affected; this one is served again once its bucket has refilled.
    expect((await viaRouter(shopHost("meadow"), "/healthz")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await viaRouter(shopHost(handle), "/healthz")).status).toBe(200);

    const metrics = compose("exec", "-T", "edge", "wget", "-qO-", "http://127.0.0.1:8001/metrics");
    expect(metrics).toMatch(new RegExp(`^router_rate_limited_total\\{cell="pool-1",tenant_id="${tenantId}"\\} [1-9]`, "m"));
  }, 60_000);
});
