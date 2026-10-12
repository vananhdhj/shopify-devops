-- migrate:up
ALTER TABLE orders.orders ADD COLUMN channel text NOT NULL;
-- migrate:down
