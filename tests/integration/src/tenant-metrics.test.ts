import { describe, expect, it } from "vitest";
import { api, orderServiceUrl, platformInternalUrl } from "./http.ts";
import { shopFetch } from "./router.ts";
import { seedProducts } from "./seed.ts";
import { checkoutOf } from "./shopping.ts";
import { compose } from "./stack.ts";
import { tenants } from "./tenants.ts";

// Phase 5's tenant dimension: the metrics that carry a shop, by its id, and the map from id to
// handle and plan that dashboards and plan-scoped alerts join on.
const edgeMetrics = () => compose("exec", "-T", "edge", "wget", "-qO-", "http://127.0.0.1:8001/metrics");
const harbor = tenants.harbor.id;

describe("the tenant dimension", () => {
  it("counts and times the edge's requests by cell and shop", async () => {
    expect((await shopFetch("/", {}, "harbor")).status).toBe(200);
    const metrics = edgeMetrics();
    expect(metrics).toMatch(new RegExp(`^router_requests_total\\{cell="pool-1",tenant_id="${harbor}",code_class="2xx"\\} [1-9]`, "m"));
    expect(metrics).toMatch(new RegExp(`^router_request_duration_seconds_count\\{cell="pool-1",tenant_id="${harbor}"\\} [1-9]`, "m"));
  });

  it("times Checkouts by shop and outcome in the order service", async () => {
    await checkoutOf({ [seedProducts.notebookSet]: 1 }, "decline");
    const metrics = await (await api(`${orderServiceUrl}/metrics`)).text();
    expect(metrics).toMatch(new RegExp(`^checkout_duration_seconds_count\\{tenant_id="${harbor}",outcome="accepted"\\} [1-9]`, "m"));
  });

  it("maps every shop's id to its handle, plan, and cell from the control plane", async () => {
    const metrics = await (await fetch(`${platformInternalUrl}/metrics`)).text();
    expect(metrics).toMatch(
      new RegExp(`^tenant_info\\{tenant_id="${harbor}",tenant="harbor",plan="starter",cell="pool-1",internal="false"\\} 1$`, "m"),
    );
    expect(metrics).toMatch(/^tenant_info\{tenant_id="[0-9a-f-]+",tenant="synthetic-pool-1",plan="starter",cell="pool-1",internal="true"\} 1$/m);
  });
});
