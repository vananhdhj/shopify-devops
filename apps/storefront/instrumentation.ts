/**
 * Runs once when the storefront server starts. Serves Prometheus process metrics on a separate,
 * private port: everything on the main port is reachable through the public ingress, so a
 * /metrics route there would publish internals to the internet. With an OTLP endpoint set
 * (Phase 7), registers a tracer provider: Next.js then makes its own request spans, continuing
 * the edge's `traceparent`, and lib/backend.ts passes the trace on to the APIs.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) await startTracing();

  const { createServer } = await import("node:http");
  const { Registry, collectDefaultMetrics } = await import("prom-client");

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const port = Number(process.env.METRICS_PORT ?? 9464);

  createServer(async (req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": registry.contentType }).end(await registry.metrics());
  }).listen(port, "0.0.0.0");
}

/** The same tracer set-up as the APIs' (`@shop/service-kit`'s `startTracing`), for Next.js. */
async function startTracing() {
  const [{ AsyncLocalStorageContextManager }, { W3CTraceContextPropagator }, { OTLPTraceExporter }, resources, sdk] =
    await Promise.all([
      import("@opentelemetry/context-async-hooks"),
      import("@opentelemetry/core"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/sdk-trace-node"),
    ]);
  const provider = new sdk.NodeTracerProvider({
    resource: resources
      .resourceFromAttributes({ "service.name": "storefront", "deployment.environment.name": process.env.APP_ENV ?? "dev" })
      .merge(resources.detectResources({ detectors: [resources.envDetector] })),
    spanProcessors: [new sdk.BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register({ contextManager: new AsyncLocalStorageContextManager(), propagator: new W3CTraceContextPropagator() });
  process.once("SIGTERM", () => void provider.shutdown());
}
