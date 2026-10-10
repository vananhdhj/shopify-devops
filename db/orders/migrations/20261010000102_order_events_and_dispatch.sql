-- migrate:up
-- Append-only status history. Each status is reached at most once per Order, so a duplicate
-- job cannot record the same transition twice.
CREATE TABLE orders.order_events (
  event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders.orders (id),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, to_status)
);

-- When an outbox event was last handed to the queue. A hint for the dispatcher only, never
-- proof that the Order was processed: the Order's status is the only proof.
ALTER TABLE orders.outbox ADD COLUMN dispatched_at timestamptz;

-- The worker shares the order identity (it belongs to the order boundary). It changes only an
-- Order's status, marks outbox dispatch, and appends status history.
GRANT UPDATE (status) ON orders.orders TO order_app;
GRANT SELECT, UPDATE (dispatched_at) ON orders.outbox TO order_app;
GRANT INSERT ON orders.order_events TO order_app;

-- migrate:down
REVOKE INSERT ON orders.order_events FROM order_app;
REVOKE SELECT, UPDATE (dispatched_at) ON orders.outbox FROM order_app;
REVOKE UPDATE (status) ON orders.orders FROM order_app;
ALTER TABLE orders.outbox DROP COLUMN dispatched_at;
DROP TABLE orders.order_events;
