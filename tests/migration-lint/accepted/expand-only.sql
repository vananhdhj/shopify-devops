-- migrate:up
-- A new nullable column, a column with a default, a new table, an index, a constraint swap.
ALTER TABLE orders.orders ADD COLUMN channel text, ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api'));
CREATE TABLE catalog.tags (id uuid PRIMARY KEY, name text NOT NULL);
CREATE INDEX tags_name ON catalog.tags (name);
ALTER TABLE catalog.tags DROP CONSTRAINT IF EXISTS tags_name_check;
CREATE FUNCTION catalog.noop() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE IF EXISTS x; END $$;
-- migrate:down
DROP TABLE catalog.tags;
