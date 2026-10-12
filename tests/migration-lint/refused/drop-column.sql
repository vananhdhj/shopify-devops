-- migrate:up
ALTER TABLE catalog.products DROP COLUMN description;
-- migrate:down
