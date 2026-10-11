import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import pg from "pg";
import type { Registry } from "prom-client";
import { loggingOptions } from "./logging.ts";
import { registerMetrics } from "./metrics.ts";
import { quietRoute } from "./routes.ts";
import { requireTenantContext, withoutTenant } from "./tenant.ts";

export interface ServiceOptions {
  /** Service name stamped on every log line, e.g. "order-service". */
  name: string;
  environment: string;
  /** Readiness fails while this database is unreachable. Units without a database omit it. */
  db?: pg.Pool;
  /** Further dependencies readiness must reach (each throws when unreachable). */
  readinessChecks?: Array<() => Promise<unknown>>;
  /** Where the service registers its own metrics; HTTP metrics are added to it. */
  registry?: Registry;
  /**
   * False for a private operational listener whose own requests are only probes and scrapes,
   * when the unit records its real traffic in the same registry elsewhere (the router).
   */
  recordRequests?: boolean;
  /**
   * When set, every route except probes, scrapes, and routes marked `withoutTenant` requires a
   * tenant context signed with this secret.
   */
  tenantContextSecret?: string;
}

/**
 * A Fastify instance with the conventions every API unit shares: structured JSON logs by
 * route template, Prometheus metrics, `{ error, message }` error bodies that never echo
 * internal errors, no request-body type coercion, and liveness/readiness probes.
 */
// Services that have begun shutting down; their readiness answers 503 from that moment.
const draining = new WeakSet<FastifyInstance>();

export function createService({
  name,
  environment,
  db,
  readinessChecks = [],
  registry,
  recordRequests = true,
  tenantContextSecret,
}: ServiceOptions): FastifyInstance {
  // No type coercion: a quantity sent as "2" is a client error, not a number.
  const app = Fastify({ ...loggingOptions(name, environment), ajv: { customOptions: { coerceTypes: false } } });
  if (tenantContextSecret) requireTenantContext(app, tenantContextSecret);
  registerMetrics(app, registry, recordRequests);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: "invalid_request", message: err.message });
    }
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal_error", message: "internal error" });
  });

  // Liveness says only that the process can answer; it must not depend on PostgreSQL,
  // or a database outage would turn into a restart storm.
  app.get("/health/live", { ...quietRoute, ...withoutTenant }, async () => ({ status: "ok" }));

  app.get("/health/ready", { ...quietRoute, ...withoutTenant }, async (_req, reply) => {
    if (draining.has(app)) return reply.code(503).send({ status: "draining" });
    try {
      await db?.query("SELECT 1");
      await Promise.all(readinessChecks.map((check) => check()));
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  return app;
}

/**
 * A pool with bounded connect and query time, so a database outage fails fast. The statement
 * timeout is enforced by PostgreSQL itself, so a query stuck on a lock is cancelled server-side
 * too, not merely abandoned by the client.
 *
 * Every client gets an `error` listener for its whole life. pg-pool listens only while a client
 * is idle; a connection that dies while checked out (a database restart or failover), or just as
 * it is handed over, would otherwise emit `error` with no listener and crash the process. The
 * failure still reaches whoever is using the client: its queries reject, and a broken client is
 * discarded on release rather than reused.
 */
export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 2_000, query_timeout: 5_000, statement_timeout: 5_000 });
  pool.on("connect", (client) => {
    client.on("error", () => {});
  });
  return pool;
}

const drainTimeoutMs = 8_000;

/**
 * Listens, then on SIGTERM/SIGINT fails readiness at once, runs `beforeClose`, stops accepting
 * requests (Fastify answers 503 while closing), lets in-flight requests finish, and exits. A drain
 * that overruns the bound exits non-zero so it is visible rather than silently killed.
 */
export async function runService(
  app: FastifyInstance,
  db: pg.Pool | undefined,
  port: number,
  /** Runs first on shutdown, e.g. to stop taking queue jobs and let active ones finish. */
  beforeClose: () => Promise<void> = async () => {},
): Promise<void> {
  // Idle clients emit errors when PostgreSQL goes away; without a listener the process would crash.
  db?.on("error", (err) => app.log.warn({ err }, "idle database client error"));

  await app.listen({ host: "0.0.0.0", port });

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    draining.add(app);

    const deadline = setTimeout(() => {
      app.log.error({ drainTimeoutMs }, "drain timed out");
      process.exit(1);
    }, drainTimeoutMs);
    deadline.unref();

    await beforeClose();
    await app.close();
    await db?.end();
    process.exit(0);
  }

  process.once("SIGTERM", (signal) => void shutdown(signal));
  process.once("SIGINT", (signal) => void shutdown(signal));
}
