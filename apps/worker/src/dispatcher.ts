import type { Pool } from "pg";
import { withTransaction } from "@shop/service-kit";
import type { JobSink } from "./queue.ts";

export const jobOptions = {
  attempts: 10,
  backoff: { type: "exponential", delay: 500 },
  removeOnComplete: { age: 3_600 },
  // A job that runs out of attempts is removed at once, freeing its job id: reconciliation
  // (ticket 05) is the long-term retry loop and re-enqueues stale Pending orders under the
  // same stable event id. Failed attempts remain visible in logs and metrics.
  removeOnFail: true,
} as const;

/**
 * Hands undispatched outbox events to the queue, using each event's stable id as the job id so
 * BullMQ ignores a duplicate while the job exists. SKIP LOCKED lets several worker replicas
 * dispatch side by side. The dispatch mark is only a hint: whether the Order was processed is
 * known from its status, never from this column.
 */
export async function dispatchOutbox(db: Pool, queue: JobSink): Promise<number> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ event_id: string; order_id: string }>(
      `SELECT event_id, order_id FROM orders.outbox
        WHERE dispatched_at IS NULL
        ORDER BY created_at
        LIMIT 50
        FOR UPDATE SKIP LOCKED`,
    );
    for (const event of rows) {
      await queue.add("settle-order", { orderId: event.order_id }, { ...jobOptions, jobId: event.event_id });
    }
    if (rows.length > 0) {
      await client.query("UPDATE orders.outbox SET dispatched_at = now() WHERE event_id = ANY($1::uuid[])", [
        rows.map((event) => event.event_id),
      ]);
    }
    return rows.length;
  });
}
