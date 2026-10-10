-- migrate:up
-- One Checkout of one Cart (ADR-0001: source_cart_id is unique). The Order token is never
-- stored: it is an HMAC of the order id, recomputed to verify a read.
CREATE TABLE orders.orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_key     text NOT NULL UNIQUE CHECK (length(checkout_key) BETWEEN 8 AND 128),
  request_hash     text NOT NULL,
  source_cart_id   uuid NOT NULL UNIQUE,
  payment_scenario text NOT NULL CHECK (payment_scenario IN ('approve', 'decline', 'slow')),
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED_OUT_OF_STOCK', 'REJECTED_PAYMENT', 'FULFILLED')),
  subtotal_minor   integer NOT NULL CHECK (subtotal_minor >= 0),
  currency         char(3) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The immutable item and price snapshot taken at Checkout. product_id is a reference
-- across the service boundary, so there is deliberately no foreign key to catalog.
CREATE TABLE orders.order_items (
  order_id         uuid NOT NULL REFERENCES orders.orders (id),
  product_id       uuid NOT NULL,
  name             text NOT NULL,
  unit_price_minor integer NOT NULL CHECK (unit_price_minor >= 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id)
);

-- Written in the same transaction as the Order; the worker dispatches it (ticket 04).
CREATE TABLE orders.outbox (
  event_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders.orders (id),
  event_type text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Least privilege for this slice: Checkout inserts Orders and their snapshot and reads them
-- back; it only appends to the outbox. No UPDATE or DELETE on order_items ever, which is
-- what keeps the snapshot immutable.
GRANT USAGE ON SCHEMA orders TO order_app;
GRANT SELECT, INSERT ON orders.orders, orders.order_items TO order_app;
GRANT INSERT ON orders.outbox TO order_app;

-- migrate:down
DROP TABLE orders.outbox;
DROP TABLE orders.order_items;
DROP TABLE orders.orders;
