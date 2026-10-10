/**
 * Runs once when the storefront server starts. Serves Prometheus process metrics on a separate,
 * private port: everything on the main port is reachable through the public ingress, so a
 * /metrics route there would publish internals to the internet.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

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
