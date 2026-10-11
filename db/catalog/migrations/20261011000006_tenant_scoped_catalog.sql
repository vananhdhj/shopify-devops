-- migrate:up
-- Every catalog row belongs to one tenant (shop). The tenant is set per transaction by the
-- service (`set_config('app.tenant_id', …, true)`); row-level security limits the catalog
-- identity to that tenant's rows. No tenant set means NULL, which matches no row and fails
-- every insert: a forgotten tenant fails closed.
CREATE FUNCTION catalog.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Rows from the single-shop era belong to the first tenant, Harbor Goods. New rows default to
-- the transaction's tenant, so inserts never name a tenant themselves.
ALTER TABLE catalog.products ADD COLUMN tenant_id uuid;
ALTER TABLE catalog.carts ADD COLUMN tenant_id uuid;
ALTER TABLE catalog.cart_items ADD COLUMN tenant_id uuid;
ALTER TABLE catalog.inventory_effects ADD COLUMN tenant_id uuid;
UPDATE catalog.products SET tenant_id = '10000000-0000-4000-8000-000000000001';
UPDATE catalog.carts SET tenant_id = '10000000-0000-4000-8000-000000000001';
UPDATE catalog.cart_items SET tenant_id = '10000000-0000-4000-8000-000000000001';
UPDATE catalog.inventory_effects SET tenant_id = '10000000-0000-4000-8000-000000000001';
ALTER TABLE catalog.products ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT catalog.current_tenant();
ALTER TABLE catalog.carts ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT catalog.current_tenant();
ALTER TABLE catalog.cart_items ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT catalog.current_tenant();
ALTER TABLE catalog.inventory_effects ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT catalog.current_tenant();

-- Tenant-scoped keys: a Cart line can only name a Cart and a Product of its own tenant, and an
-- Inventory effect is recorded once per tenant, Order, and action.
ALTER TABLE catalog.products ADD CONSTRAINT products_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE catalog.carts ADD CONSTRAINT carts_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE catalog.cart_items
  DROP CONSTRAINT cart_items_cart_id_fkey,
  DROP CONSTRAINT cart_items_product_id_fkey,
  DROP CONSTRAINT cart_items_pkey,
  ADD PRIMARY KEY (tenant_id, cart_id, product_id),
  ADD CONSTRAINT cart_items_cart_fkey FOREIGN KEY (tenant_id, cart_id) REFERENCES catalog.carts (tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT cart_items_product_fkey FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id);
ALTER TABLE catalog.inventory_effects
  DROP CONSTRAINT inventory_effects_pkey,
  ADD PRIMARY KEY (tenant_id, order_id, action);

-- Row-level security. Enabled, not forced: the migration identity owns these tables and works
-- across tenants for migrations and seeding; the catalog identity never owns a table and has
-- no BYPASSRLS, so these policies always apply to it.
ALTER TABLE catalog.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.carts ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.inventory_effects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON catalog.products TO catalog_app
  USING (tenant_id = catalog.current_tenant()) WITH CHECK (tenant_id = catalog.current_tenant());
CREATE POLICY tenant_isolation ON catalog.carts TO catalog_app
  USING (tenant_id = catalog.current_tenant()) WITH CHECK (tenant_id = catalog.current_tenant());
CREATE POLICY tenant_isolation ON catalog.cart_items TO catalog_app
  USING (tenant_id = catalog.current_tenant()) WITH CHECK (tenant_id = catalog.current_tenant());
CREATE POLICY tenant_isolation ON catalog.inventory_effects TO catalog_app
  USING (tenant_id = catalog.current_tenant()) WITH CHECK (tenant_id = catalog.current_tenant());

-- migrate:down
DROP POLICY tenant_isolation ON catalog.inventory_effects;
DROP POLICY tenant_isolation ON catalog.cart_items;
DROP POLICY tenant_isolation ON catalog.carts;
DROP POLICY tenant_isolation ON catalog.products;
ALTER TABLE catalog.inventory_effects DISABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.cart_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.carts DISABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.products DISABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.inventory_effects DROP CONSTRAINT inventory_effects_pkey, ADD PRIMARY KEY (order_id, action);
ALTER TABLE catalog.cart_items
  DROP CONSTRAINT cart_items_product_fkey,
  DROP CONSTRAINT cart_items_cart_fkey,
  DROP CONSTRAINT cart_items_pkey,
  ADD PRIMARY KEY (cart_id, product_id),
  ADD CONSTRAINT cart_items_cart_id_fkey FOREIGN KEY (cart_id) REFERENCES catalog.carts (id) ON DELETE CASCADE,
  ADD CONSTRAINT cart_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES catalog.products (id);
ALTER TABLE catalog.carts DROP CONSTRAINT carts_tenant_id_id_key;
ALTER TABLE catalog.products DROP CONSTRAINT products_tenant_id_id_key;
ALTER TABLE catalog.inventory_effects DROP COLUMN tenant_id;
ALTER TABLE catalog.cart_items DROP COLUMN tenant_id;
ALTER TABLE catalog.carts DROP COLUMN tenant_id;
ALTER TABLE catalog.products DROP COLUMN tenant_id;
DROP FUNCTION catalog.current_tenant();
