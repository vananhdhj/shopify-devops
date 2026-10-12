-- migrate:up
-- The cell directory: every cell the control plane can place shops in. Git declares a cell (its
-- directory under deploy/cells/); the cell enters this table by registering itself once its units
-- are healthy, with its role, its capacity, and where its APIs answer. Only a registered cell
-- (registered_at set) takes new shops.
CREATE TABLE platform.cells (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$'),
  role           text NOT NULL CHECK (role IN ('canary', 'pooled', 'dedicated')),
  -- The most shops (not yet deleted) the cell holds; a dedicated cell holds exactly one.
  capacity       integer NOT NULL CHECK (capacity > 0),
  storefront_url text,
  catalog_url    text,
  orders_url     text,
  registered_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'dedicated' OR capacity = 1),
  CHECK (registered_at IS NULL OR (storefront_url IS NOT NULL AND catalog_url IS NOT NULL AND orders_url IS NOT NULL))
);

-- Phase 2's one cell becomes the pooled cell pool-1, entered here unregistered, so its shops keep
-- a valid cell until it registers with its URLs.
INSERT INTO platform.cells (id, role, capacity) VALUES ('pool-1', 'pooled', 100);
UPDATE platform.tenants SET cell = 'pool-1' WHERE cell = 'cell-1';
ALTER TABLE platform.tenants ADD CONSTRAINT tenants_cell_fkey FOREIGN KEY (cell) REFERENCES platform.cells (id);

-- What the shop pays for decides where it is placed; internal shops (the platform's own synthetic
-- shop) go to the canary cell only. Neither changes after signup in this phase.
ALTER TABLE platform.tenants
  ADD COLUMN plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'plus')),
  ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE INDEX tenants_cell ON platform.tenants (cell) WHERE status <> 'DELETED';

-- Signup now writes two events in one transaction (created, placed); now() would give both the
-- same time, so the audit trail would lose their order.
ALTER TABLE platform.tenant_events ALTER COLUMN created_at SET DEFAULT clock_timestamp();

GRANT SELECT, INSERT ON platform.cells TO platform_app;
GRANT UPDATE (role, capacity, storefront_url, catalog_url, orders_url, registered_at, updated_at) ON platform.cells TO platform_app;

-- migrate:down
ALTER TABLE platform.tenant_events ALTER COLUMN created_at SET DEFAULT now();
REVOKE ALL ON platform.cells FROM platform_app;
DROP INDEX platform.tenants_cell;
ALTER TABLE platform.tenants DROP COLUMN internal, DROP COLUMN plan;
ALTER TABLE platform.tenants DROP CONSTRAINT tenants_cell_fkey;
UPDATE platform.tenants SET cell = 'cell-1' WHERE cell = 'pool-1';
DROP TABLE platform.cells;
