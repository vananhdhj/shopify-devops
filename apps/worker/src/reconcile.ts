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
  const { rowCount } = await db.query(
    `UPDATE orders.outbox AS event
        SET dispatched_at = NULL
       FROM orders.orders AS o
      WHERE o.id = event.order_id
        AND o.status = 'PENDING'
        AND event.dispatched_at < now() - make_interval(secs => $1::float / 1000)`,
    [staleAfterMs],
  );
  return rowCount ?? 0;
}
