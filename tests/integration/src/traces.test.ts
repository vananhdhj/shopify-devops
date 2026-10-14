import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Browser } from "./browser.ts";
import { seedProducts } from "./seed.ts";
import { compose, logLinesWith } from "./stack.ts";
import { tenants } from "./tenants.ts";

/**
 * Phase 7's traces: a buyer's Checkout through the edge is one trace in Tempo, from the edge
 * through the storefront, the order service, and the catalog API, across the outbox and the queue,
 * to the worker's settlement; and the units' log lines carry its trace id.
 */
const tempoUrl = process.env.TEMPO_URL ?? "http://127.0.0.1:3200";

interface Span {
  service: string;
  name: string;
  kind: string;
  attributes: Record<string, unknown>;
}

/** Tempo's trace as flat spans, each with the service that made it. */
async function spansOf(traceId: string): Promise<Span[] | undefined> {
  const res = await fetch(`${tempoUrl}/api/v2/traces/${traceId}`);
  if (res.status === 404) return undefined;
  const body = (await res.json()) as {
    trace?: { resourceSpans?: { resource: { attributes: Attr[] }; scopeSpans: { spans: RawSpan[] }[] }[] };
  };
  return (body.trace?.resourceSpans ?? []).flatMap((batch) => {
    const service = String(attributeValue(batch.resource.attributes, "service.name"));
    return batch.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => ({
        service,
        name: span.name,
        kind: span.kind,
        attributes: Object.fromEntries((span.attributes ?? []).map((a) => [a.key, attributeValue([a], a.key)])),
      })),
    );
  });
}
interface Attr {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean };
}
interface RawSpan {
  name: string;
  kind: string;
  attributes?: Attr[];
}
const attributeValue = (attrs: Attr[], key: string) => {
  const value = attrs.find((a) => a.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.boolValue;
};

/** The trace whose spans name this Order (TraceQL), once Tempo has it. */
async function traceOfOrder(orderId: string): Promise<string | undefined> {
  const q = `{ span.order.id = "${orderId}" }`;
  const res = await fetch(`${tempoUrl}/api/search?q=${encodeURIComponent(q)}&limit=5&start=${Math.floor(Date.now() / 1000) - 600}&end=${Math.floor(Date.now() / 1000) + 60}`);
  const { traces } = (await res.json()) as { traces?: { traceID: string }[] };
  return traces?.[0]?.traceID;
}

function checkoutKeyIn(html: string): string {
  const match = html.match(/name="checkoutKey" value="([^"]+)"/);
  if (!match) throw new Error("checkout form has no checkoutKey");
  return match[1]!;
}

describe("traces", () => {
  it("follows a buyer's Checkout from the edge through the queue to its settlement, in one trace", async () => {
    const buyer = new Browser();
    await buyer.submit("/cart/items", { productId: seedProducts.notebookSet, action: "add" });
    const placed = await buyer.submit("/orders", { checkoutKey: checkoutKeyIn(await buyer.html("/checkout")), paymentScenario: "approve" });
    expect(placed.status).toBe(303);
    const orderId = placed.headers.get("location")!.match(/^\/orders\/([0-9a-f-]{36})/)![1]!;

    // The whole trace: every unit's spans, the settlement's last.
    let spans: Span[] = [];
    await expect
      .poll(
        async () => {
          const traceId = await traceOfOrder(orderId);
          spans = (traceId && (await spansOf(traceId))) || [];
          return spans.some((span) => span.name === "settle order") && spans.some((span) => span.name.includes("inventory deduct"));
        },
        { timeout: 45_000, interval: 1_000 },
      )
      .toBe(true);

    expect(new Set(spans.map((span) => span.service))).toEqual(new Set(["router", "storefront", "order-service", "catalog-cart-api", "worker"]));
    const named = (name: string) => spans.filter((span) => span.name === name);
    expect(named("POST /checkout")).toHaveLength(1);
    expect(named("POST /checkout")[0]!.attributes).toMatchObject({ "tenant.id": tenants.harbor.id, "order.id": orderId });
    expect(named("outbox dispatch")[0]).toMatchObject({ service: "worker", kind: "SPAN_KIND_PRODUCER", attributes: { "order.id": orderId } });
    expect(named("settle order")[0]).toMatchObject({ service: "worker", kind: "SPAN_KIND_CONSUMER", attributes: { "tenant.id": tenants.harbor.id, "order.settlement": "confirmed" } });
    expect(spans.filter((span) => span.service === "catalog-cart-api").map((span) => span.name)).toEqual(
      expect.arrayContaining(["GET /carts/:id", "POST /internal/inventory-effects"]),
    );
    expect(spans.find((span) => span.service === "router")).toMatchObject({ name: "POST /*", attributes: { "tenant.id": tenants.harbor.id, cell: "pool-1" } });
    expect(spans.some((span) => span.name === "db transaction" && span.service === "order-service")).toBe(true);
  });

  it("puts the trace id on the units' log lines", async () => {
    const requestId = `trace-log-${randomUUID()}`;
    const res = await new Browser().get("/", { "x-request-id": requestId });
    expect(res.status).toBe(200);
    await expect.poll(() => logLinesWith("catalog-cart-api", requestId).length, { timeout: 10_000 }).toBeGreaterThan(0);
    // Fastify's "incoming request" line comes before the span; the lines after it carry its id.
    const traced = (service: string) => logLinesWith(service, requestId).filter((line) => line.traceId !== undefined);
    const [catalogLine] = traced("catalog-cart-api");
    const [edgeLine] = traced("edge");
    expect(catalogLine!.traceId).toMatch(/^[0-9a-f]{32}$/);
    // The same trace from the edge to the catalog API.
    expect(edgeLine!.traceId).toBe(catalogLine!.traceId);
  });

  it("starts its own trace at the edge, whatever trace context a client sends", async () => {
    const requestId = `trace-forged-${randomUUID()}`;
    const forged = "0af7651916cd43dd8448eb211c80319c";
    const res = await new Browser().get("/", { "x-request-id": requestId, traceparent: `00-${forged}-b7ad6b7169203331-01` });
    expect(res.status).toBe(200);
    await expect.poll(() => logLinesWith("catalog-cart-api", requestId).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const traceIds = new Set(
      [...logLinesWith("edge", requestId), ...logLinesWith("catalog-cart-api", requestId)].map((line) => line.traceId).filter(Boolean),
    );
    expect(traceIds.size).toBe(1);
    expect(traceIds.has(forged)).toBe(false);
  });

  it("runs Tempo in the stack", () => {
    expect(compose("ps", "--status", "running", "--format", "{{.Service}}", "tempo")).toContain("tempo");
  });
});
