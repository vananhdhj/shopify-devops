-- migrate:up
-- One row per (Order, action): the deduplication record that makes an Inventory effect apply
-- at most once however often it is requested. It is written in the same transaction as the
-- Stock change it records. `items` keeps what a deduction took, so a release returns exactly that.
CREATE TABLE catalog.inventory_effects (
  order_id   uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('deduct', 'release')),
  outcome    text NOT NULL CHECK (outcome IN ('applied', 'insufficient_stock', 'nothing_to_release')),
  items      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, action)
);

-- Stock changes only through Inventory effects: the runtime identity may update the stock
-- column and nothing else on products, and may only append effect records.
GRANT UPDATE (stock) ON catalog.products TO catalog_app;
GRANT SELECT, INSERT ON catalog.inventory_effects TO catalog_app;

-- migrate:down
REVOKE UPDATE (stock) ON catalog.products FROM catalog_app;
DROP TABLE catalog.inventory_effects;
