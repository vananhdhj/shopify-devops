import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformQuery } from "./db.ts";
import { platformInternalUrl } from "./http.ts";
import { secret } from "./secrets.ts";
import { compose } from "./stack.ts";

/**
 * The promoter (Phase 4) in Compose, against a stub of the Kubernetes API (Argo CD's cell
 * Applications), Prometheus, and GitHub that this file serves on the host (port 18199). Its
 * synthetic Checkouts are real: pool-1's synthetic shop, through the edge. Wave 0 is pool-1 in the
 * stub's fleet; wave 1 is a cell that exists only in the stub. Ticks are 0.5 s, the soak 4 s.
 */
interface Dispatch {
  ref: string;
  inputs: { wave: string; digests: string; gate: string };
}
const stub = {
  waves: [] as { cell: string; wave: number; namespace: string; release: Record<string, string>; healthy: boolean }[],
  metrics: {} as Record<string, { errorRatio?: number; oldestPendingSeconds?: number; firingAlerts?: number }>,
  dispatches: [] as Dispatch[],
};

function answer(path: string, query: string | null): unknown {
  if (path === "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications") {
    return {
      items: stub.waves.map((cell) => ({
        metadata: { name: `cell-${cell.cell}-dev`, labels: { "shop.example/cell": cell.cell, "shop.example/wave": String(cell.wave) } },
        spec: { destination: { namespace: cell.namespace } },
        status: {
          sync: { status: "Synced" },
          health: { status: cell.healthy ? "Healthy" : "Degraded" },
          summary: { images: Object.entries(cell.release).map(([image, digest]) => `${image}@${digest}`) },
        },
      })),
    };
  }
  if (path === "/api/v1/query" && query) {
    const namespace = /namespace="([^"]+)"/.exec(query)?.[1] ?? "";
    const m = stub.metrics[namespace] ?? {};
    const value = query.includes("ALERTS") ? m.firingAlerts : query.includes("orders_oldest") ? m.oldestPendingSeconds : m.errorRatio;
    return { status: "success", data: { result: value === undefined ? [] : [{ value: [0, String(value)] }] } };
  }
  return undefined;
}

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (req.method === "POST" && url.pathname === "/repos/test/shop/actions/workflows/promote.yml/dispatches") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        stub.dispatches.push(JSON.parse(body) as Dispatch);
        res.writeHead(204).end();
      });
      return;
    }
    const reply = answer(url.pathname, url.searchParams.get("query"));
    if (reply === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(18199, "0.0.0.0", resolve));
  compose("--profile", "promoter", "up", "--detach", "--build", "--wait", "--no-deps", "platform-promoter");
}, 300_000);

afterAll(async () => {
  compose("--profile", "promoter", "stop", "platform-promoter");
  await new Promise((resolve) => server.close(resolve));
}, 60_000);

const digest = () => `sha256:${randomBytes(32).toString("hex")}`;
const release = () => ({ "ghcr.io/test/storefront": digest(), "ghcr.io/test/worker": digest() });
const keyOf = (r: Record<string, string>) =>
  Object.keys(r)
    .sort()
    .map((image) => `${image}@${r[image]}`)
    .join(",");

/** Wave 0 is pool-1 (real synthetic shop) on `zero`; wave 1 is a stub-only cell on `one`. */
function fleet(zero: Record<string, string>, one: Record<string, string>) {
  stub.waves = [
    { cell: "pool-1", wave: 0, namespace: "stub-pool-1", release: zero, healthy: true },
    { cell: "stub-next", wave: 1, namespace: "stub-next", release: one, healthy: true },
  ];
}

const promotion = async (r: Record<string, string>) =>
  (
    await platformQuery<{ id: string; state: string; soak_started_at: Date; exposed_cells: string[] | null; exposed_tenants: number | null; gate: { ticks?: number } }>(
      "SELECT id, state, soak_started_at, exposed_cells, exposed_tenants, gate FROM platform.promotions WHERE release_key = $1 AND wave = 0",
      [keyOf(r)],
    )
  )[0];
const steps = async (id: string) =>
  (await platformQuery<{ step: string }>("SELECT step FROM platform.promotion_events WHERE promotion_id = $1 ORDER BY id", [id])).map(
    (row) => row.step,
  );
// The digests come back from a jsonb column, in its key order: compare them as objects.
const dispatchesOf = (r: Record<string, string>) => stub.dispatches.filter((d) => keyOf(JSON.parse(d.inputs.digests) as Record<string, string>) === keyOf(r));
const promoterMetrics = async () => (await fetch("http://127.0.0.1:8103/metrics")).text();

describe("the promoter", () => {
  it("buys from every cell's synthetic shop continuously, soak or not, and times its own ticks", async () => {
    await expect.poll(promoterMetrics, { timeout: 30_000, interval: 1_000 }).toMatch(/^synthetic_checkout_total\{cell="pool-1",outcome="passed"\} [1-9]/m);
    const metrics = await promoterMetrics();
    expect(metrics).toMatch(/^synthetic_checkout_consecutive_failures\{cell="pool-1"\} 0$/m);
    expect(metrics).toMatch(/^promoter_tick_seconds_count [1-9]/m);
  }, 60_000);

  it("soaks a release the next wave lacks, dispatches its promotion once, and marks it promoted", async () => {
    const old = release();
    const fresh = release();
    stub.metrics["stub-pool-1"] = { errorRatio: 0, firingAlerts: 0 };
    fleet(fresh, old);

    await expect.poll(async () => (await promotion(fresh))?.state, { timeout: 60_000, interval: 500 }).toBe("promoting");
    expect(dispatchesOf(fresh)).toHaveLength(1);
    expect(dispatchesOf(fresh)[0]).toMatchObject({ ref: "main", inputs: { wave: "1" } });
    expect(dispatchesOf(fresh)[0]!.inputs.gate).toMatch(/^soaked \d+ s in wave 0 \(pool-1\)/);

    // GitHub committed; Argo CD synced wave 1.
    fleet(fresh, fresh);
    await expect.poll(async () => (await promotion(fresh))?.state, { timeout: 15_000, interval: 500 }).toBe("promoted");
    expect(await steps((await promotion(fresh))!.id)).toEqual(["soak_started", "dispatched", "promoted"]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(dispatchesOf(fresh)).toHaveLength(1);
  }, 120_000);

  it("resumes a soak after a restart: one soak, one dispatch", async () => {
    const old = release();
    const fresh = release();
    stub.metrics["stub-pool-1"] = { errorRatio: 0, firingAlerts: 0 };
    fleet(fresh, old);
    await expect.poll(async () => (await promotion(fresh))?.state, { timeout: 30_000, interval: 250 }).toBe("soaking");
    const before = (await promotion(fresh))!;

    compose("--profile", "promoter", "restart", "platform-promoter");
    await expect.poll(async () => (await promotion(fresh))?.state, { timeout: 60_000, interval: 500 }).toBe("promoting");
    const after = (await promotion(fresh))!;
    expect(after.id).toBe(before.id);
    expect(after.soak_started_at).toEqual(before.soak_started_at);
    // The gate kept counting from where it was (no tick yet is an empty gate).
    expect(after.gate.ticks).toBeGreaterThan(before.gate.ticks ?? 0);
    expect((await steps(after.id)).filter((step) => step === "soak_started")).toHaveLength(1);
    expect(dispatchesOf(fresh)).toHaveLength(1);
    fleet(fresh, fresh);
  }, 120_000);

  it("halts a release whose cell fails a check, counts the tenants it reached, and never promotes it", async () => {
    const old = release();
    const bad = release();
    stub.metrics["stub-pool-1"] = { errorRatio: 0.5, firingAlerts: 0 };
    fleet(bad, old);

    await expect.poll(async () => (await promotion(bad))?.state, { timeout: 30_000, interval: 250 }).toBe("halted");
    const halted = (await promotion(bad))!;
    const [real] = await platformQuery<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.tenants WHERE cell = 'pool-1' AND NOT internal AND status <> 'DELETED'",
    );
    expect(halted).toMatchObject({ exposed_cells: ["pool-1"], exposed_tenants: real!.n });
    expect(await steps(halted.id)).toEqual(["soak_started", "halted"]);
    await expect.poll(promoterMetrics, { timeout: 10_000, interval: 500 }).toMatch(/^promotion_halted\{wave="0"\} 1$/m);

    // The operator sees it, with what failed.
    const res = await fetch(`${platformInternalUrl}/operator/promotions`, { headers: { "x-operator-token": secret("PLATFORM_OPERATOR_TOKEN") } });
    const { promotions } = (await res.json()) as { promotions: { id: string; state: string; failure: { check: string } | null }[] };
    expect(promotions.find((p) => p.id === halted.id)).toMatchObject({ state: "halted", failure: { check: "error_ratio" } });

    // The cell recovers: the release stays halted and is never dispatched.
    stub.metrics["stub-pool-1"] = { errorRatio: 0, firingAlerts: 0 };
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect((await promotion(bad))?.state).toBe("halted");
    expect(dispatchesOf(bad)).toHaveLength(0);

    // The operator reverts: wave 0 runs the old release again, and the alert's metric clears.
    fleet(old, old);
    await expect.poll(promoterMetrics, { timeout: 10_000, interval: 500 }).not.toMatch(/^promotion_halted\{wave="0"\} 1$/m);
  }, 120_000);
});
