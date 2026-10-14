import type pg from "pg";
import { SpanKind, withSpan } from "./tracing.ts";

/**
 * Runs `work` inside one transaction on a pooled client: commits when it returns, rolls back
 * and rethrows when it throws, and always returns the client to the pool.
 */
export async function withTransaction<T>(db: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  // One span per transaction (Phase 7): a trace shows each unit's time in PostgreSQL.
  const span = { kind: SpanKind.CLIENT, attributes: { "db.system.name": "postgresql" }, onlyInTrace: true };
  return withSpan("db transaction", span, async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      // On a dead connection the rollback fails too; the original error is the one that matters.
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
