-- migrate:up
-- A Cart's id is a random v4 UUID and doubles as the Guest buyer's cart token.
CREATE TABLE catalog.carts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A line exists only while its quantity is positive; setting quantity 0 deletes the row.
CREATE TABLE catalog.cart_items (
  cart_id    uuid NOT NULL REFERENCES catalog.carts (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES catalog.products (id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (cart_id, product_id)
);

-- Least privilege for this slice: UPDATE on carts only touches updated_at; DELETE on
-- cart_items is how quantity 0 removes a line. Carts themselves are never deleted.
GRANT SELECT, INSERT, UPDATE ON catalog.carts TO catalog_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.cart_items TO catalog_app;

-- migrate:down
DROP TABLE catalog.cart_items;
DROP TABLE catalog.carts;
