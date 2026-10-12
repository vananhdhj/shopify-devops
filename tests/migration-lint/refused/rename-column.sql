-- migrate:up
ALTER TABLE catalog.products RENAME COLUMN name TO title;
-- migrate:down
