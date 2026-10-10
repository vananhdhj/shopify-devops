import pg from "pg";
import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { loggingOptions } from "./logging.ts";

const db = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 2_000,
  query_timeout: 5_000,
});
const app = buildApp({ db }, loggingOptions("catalog-cart-api", config.environment));

// Idle clients emit errors when PostgreSQL goes away; without a listener the process would crash.
db.on("error", (err) => app.log.warn({ err }, "idle database client error"));

await app.listen({ host: "0.0.0.0", port: config.port });

// On SIGTERM/SIGINT: stop accepting requests (Fastify answers 503 while closing, which also
// fails readiness), let in-flight requests finish, then exit. A drain that overruns the bound
// exits non-zero so it is visible rather than silently killed.
const drainTimeoutMs = 8_000;
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");

  const deadline = setTimeout(() => {
    app.log.error({ drainTimeoutMs }, "drain timed out");
    process.exit(1);
  }, drainTimeoutMs);
  deadline.unref();

  await app.close();
  await db.end();
  process.exit(0);
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));
