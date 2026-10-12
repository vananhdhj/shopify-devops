-- migrate:up
ALTER TABLE orders.orders ALTER COLUMN note SET NOT NULL;
-- migrate:down
