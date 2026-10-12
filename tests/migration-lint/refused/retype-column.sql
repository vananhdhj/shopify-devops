-- migrate:up
ALTER TABLE catalog.products ALTER COLUMN price_minor TYPE numeric;
-- migrate:down
