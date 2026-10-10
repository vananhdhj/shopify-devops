import type { FastifyInstance } from "fastify";
import { Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { quietRoute } from "./routes.ts";

/**
 * Exposes Prometheus metrics at /metrics. Requests are labelled by route template
 * (`/products/:id`), never the raw URL, so ids cannot explode label cardinality.
 */
export function registerMetrics(app: FastifyInstance, registry: Registry = new Registry()): void {
  collectDefaultMetrics({ register: registry });

  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration by method, route template, and status code",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook("onResponse", async (req, reply) => {
    duration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? "unmatched",
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get("/metrics", quietRoute, async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });
}
