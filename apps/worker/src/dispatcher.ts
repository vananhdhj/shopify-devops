import type { Pool } from "pg";
import { withTransaction } from "@shop/service-kit";
import type { JobSink } from "./queue.ts";
import { withTimeout } from "./timeout.ts";

export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
}

function settleJobOptions(retry: RetryPolicy, jobId: string) {
  return {
    jobId,
    attempts: retry.attempts,
    backoff: { type: "exponential", delay: retry.backoffMs },
    removeOnComplete: { age: 3_600 },
    // A job that runs out of attempts is removed at once, freeing its job id: reconciliation is
    // the long-term retry loop and re-enqueues stale Pending orders under the same stable event
    // id. Failed attempts remain visible in logs and metrics.
    removeOnFail: true,
  } as const;
}

/** How long one enqueue may take before the dispatch transaction gives up and rolls back. */
const enqueueTimeoutMs = 2_000;

/**
 * Hands undispatched outbox events of every tenant in the cell to the queue, fairly (Phase 5): at
 * most `perTenant` of a tenant's Orders are in the queue or being settled at a time, and tenants
 * are taken round-robin, so one shop's burst waits in its own outbox while every other shop's
 * Orders go straight in. Each event's stable id is the job id, so BullMQ ignores a duplicate while
 * the job exists. The events are claimed through a narrow database function (the order identity
 * has no direct access to other tenants' outbox rows); its SKIP LOCKED row locks last until this
 * transaction ends, so several worker replicas dispatch side by side. The dispatch mark is only a
 * hint: whether the Order was processed is known from its status, never from this column.
 */
export async function dispatchOutbox(db: Pool, queue: JobSink, retry: RetryPolicy, perTenant: number): Promise<number> {
  return withTransaction(db, async (client) => {
    const { rows } = await client.query<{ event_id: string; tenant_id: string; order_id: string }>(
      "SELECT event_id, tenant_id, order_id FROM orders.claim_fair_events(50, $1)",
      [perTenant],
    );
    for (const event of rows) {
      await withTimeout(
        queue.add(
          "settle-order",
          { tenantId: event.tenant_id, orderId: event.order_id },
          settleJobOptions(retry, event.event_id),
        ),
        enqueueTimeoutMs,
        "queue unreachable",
      );
    }
    if (rows.length > 0) {
      await client.query("SELECT orders.mark_events_dispatched($1::uuid[])", [rows.map((event) => event.event_id)]);
    }
    return rows.length;
  });
}
