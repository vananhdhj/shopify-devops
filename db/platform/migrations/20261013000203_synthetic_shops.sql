-- migrate:up
-- Every cell holds one synthetic shop: an internal shop the control plane creates when the cell
-- registers (handle `synthetic-<cell>`), which the promoter buys from to gate a release in that
-- cell. It is outside the cell's capacity, so a dedicated cell still takes one plus shop. At most
-- one per cell that is not deleted.
CREATE UNIQUE INDEX tenants_one_synthetic_shop_per_cell ON platform.tenants (cell) WHERE internal AND status <> 'DELETED';

-- `synthetic-` and the cell id must fit one DNS label of at most 30 characters.
ALTER TABLE platform.cells ADD CONSTRAINT cells_id_fits_a_synthetic_handle CHECK (char_length(id) <= 20);

-- A cell's registration creates its synthetic shop, and records itself as the actor.
ALTER TABLE platform.tenant_events DROP CONSTRAINT tenant_events_actor_check;
ALTER TABLE platform.tenant_events ADD CONSTRAINT tenant_events_actor_check
  CHECK (actor IN ('seed', 'signup', 'operator', 'platform-worker', 'registration'));

-- migrate:down
ALTER TABLE platform.tenant_events DROP CONSTRAINT tenant_events_actor_check;
ALTER TABLE platform.tenant_events ADD CONSTRAINT tenant_events_actor_check
  CHECK (actor IN ('seed', 'signup', 'operator', 'platform-worker'));
ALTER TABLE platform.cells DROP CONSTRAINT cells_id_fits_a_synthetic_handle;
DROP INDEX platform.tenants_one_synthetic_shop_per_cell;
