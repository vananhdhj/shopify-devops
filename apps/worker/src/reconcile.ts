import type { Pool } from "pg";

/**
 * Finds Pending orders whose outbox event was dispatched longer ago than `staleAfterMs` and
 * clears the dispatch mark (the threshold runs from the last dispatch, so an Order is requeued
 * at most once per window; events never dispatched are the dispatcher's job anyway), so the dispatcher enqueues them again under the same stable event
 * id. While the original job still exists BullMQ ignores the duplicate; if the job was lost or
 * ran out of attempts, it is recreated. Settling stays safe to repeat, so a false alarm costs
 * nothing, and no Inventory effect is ever created under a new key. Pending orders never
 * expire (ADR-0002): they are re-enqueued for as long as they stay Pending.
 */
export async function reconcileStalePending(db: Pool, staleAfterMs: number): Promise<number> {
  // Spans every tenant in the cell, so it goes through a narrow database function.
  const { rows } = await db.query<{ requeued: number }>(
    "SELECT orders.requeue_stale_pending(make_interval(secs => $1::float / 1000)) AS requeued",
    [staleAfterMs],
  );
  return rows[0]?.requeued ?? 0;
}
