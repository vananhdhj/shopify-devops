-- migrate:up
CREATE TABLE catalog.products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) > 0),
  description text NOT NULL DEFAULT '',
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency    char(3) NOT NULL DEFAULT 'USD',
  stock       integer NOT NULL CHECK (stock >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Runtime identities get only what their slice needs; later migrations widen this
-- deliberately (stock changes go through Inventory effects, never ad-hoc UPDATEs).
GRANT USAGE ON SCHEMA catalog TO catalog_app;
GRANT SELECT ON catalog.products TO catalog_app;

-- migrate:down
DROP TABLE catalog.products;
