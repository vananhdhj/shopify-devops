---
status: accepted
---

# Order events are write-only for the services

`orders.order_events` is an append-only status history, and `order_app` may only `INSERT` into it. No API, metric or dashboard reads it; only the integration tests do. Its main job is to make duplicates safe: each status change and its event are written in one transaction, and `UNIQUE (order_id, to_status)` means a redelivered queue job cannot record the same transition twice. The history it leaves is an audit trail that costs little to write now and could not be rebuilt later. Nothing in the POC needs to read it: Merchant and buyer views show the current status, and metrics come from `orders.orders` and the worker's counters.

## Considered Options

- **No history table**: rejected; status changes would leave no record of when they happened, and the slow-payment and status-sequence tests would have nothing to check.
- **Expose it (an Order timeline, a time-to-settle metric)**: not added; no POC story asks for it.

## Consequences

- Reading it in a service means granting `SELECT` to whichever identity reads it.
- It records when a transition happened, not which unit made it (see ADR-0006).
