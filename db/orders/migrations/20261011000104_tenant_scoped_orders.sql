-- migrate:up
-- Every order row belongs to one tenant (shop), set per transaction by the service; row-level
-- security limits the order identity to that tenant's rows. No tenant set means NULL, which
-- matches no row and fails every insert.
CREATE FUNCTION orders.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Rows from the single-shop era belong to the first tenant, Harbor Goods.
ALTER TABLE orders.orders ADD COLUMN tenant_id uuid;
ALTER TABLE orders.order_items ADD COLUMN tenant_id uuid;
ALTER TABLE orders.outbox ADD COLUMN tenant_id uuid;
ALTER TABLE orders.order_events ADD COLUMN tenant_id uuid;
UPDATE orders.orders SET tenant_id = '10000000-0000-4000-8000-000000000001';
UPDATE orders.order_items SET tenant_id = '10000000-0000-4000-8000-000000000001';
UPDATE orders.outbox SET tenant_id = '10000000-0000-4000-8000-000000000001';
UPDATE orders.order_events SET tenant_id = '10000000-0000-4000-8000-000000000001';
ALTER TABLE orders.orders ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT orders.current_tenant();
ALTER TABLE orders.order_items ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT orders.current_tenant();
ALTER TABLE orders.outbox ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT orders.current_tenant();
ALTER TABLE orders.order_events ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN tenant_id SET DEFAULT orders.current_tenant();

-- Tenant-scoped keys: a Checkout key and a source Cart are unique within a shop (ADR-0001 per
-- tenant), and an Order's items, outbox events, and history can only belong to an Order of the
-- same tenant.
ALTER TABLE orders.orders
  DROP CONSTRAINT orders_checkout_key_key,
  DROP CONSTRAINT orders_source_cart_id_key,
  ADD CONSTRAINT orders_tenant_checkout_key_key UNIQUE (tenant_id, checkout_key),
  ADD CONSTRAINT orders_tenant_source_cart_key UNIQUE (tenant_id, source_cart_id),
  ADD CONSTRAINT orders_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE orders.order_items
  DROP CONSTRAINT order_items_order_id_fkey,
  DROP CONSTRAINT order_items_pkey,
  ADD PRIMARY KEY (tenant_id, order_id, product_id),
  ADD CONSTRAINT order_items_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders.orders (tenant_id, id);
ALTER TABLE orders.outbox
  DROP CONSTRAINT outbox_order_id_fkey,
  ADD CONSTRAINT outbox_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders.orders (tenant_id, id);
ALTER TABLE orders.order_events
  DROP CONSTRAINT order_events_order_id_fkey,
  DROP CONSTRAINT order_events_order_id_to_status_key,
  ADD CONSTRAINT order_events_order_fkey FOREIGN KEY (tenant_id, order_id) REFERENCES orders.orders (tenant_id, id),
  ADD CONSTRAINT order_events_tenant_order_to_status_key UNIQUE (tenant_id, order_id, to_status);

-- Row-level security, enabled but not forced: the migration identity owns the tables and works
-- across tenants; the order identity owns nothing and has no BYPASSRLS.
ALTER TABLE orders.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders.order_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders.orders TO order_app
  USING (tenant_id = orders.current_tenant()) WITH CHECK (tenant_id = orders.current_tenant());
CREATE POLICY tenant_isolation ON orders.order_items TO order_app
  USING (tenant_id = orders.current_tenant()) WITH CHECK (tenant_id = orders.current_tenant());
CREATE POLICY tenant_isolation ON orders.outbox TO order_app
  USING (tenant_id = orders.current_tenant()) WITH CHECK (tenant_id = orders.current_tenant());
CREATE POLICY tenant_isolation ON orders.order_events TO order_app
  USING (tenant_id = orders.current_tenant()) WITH CHECK (tenant_id = orders.current_tenant());

-- Cross-tenant work. The worker's outbox dispatcher and reconciliation, and the oldest-Pending
-- gauge, look at every tenant. They get these narrow functions instead of table access: each
-- runs as the migration identity (which owns the tables, so RLS does not apply to it) and
-- returns only ids, tenants, and timestamps, never Order contents.

-- Locks and returns up to `batch` undispatched outbox events; the locks last until the caller's
-- transaction ends, so several dispatchers can work side by side (SKIP LOCKED).
CREATE FUNCTION orders.claim_undispatched_events(batch integer)
RETURNS TABLE (event_id uuid, tenant_id uuid, order_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT e.event_id, e.tenant_id, e.order_id
    FROM orders.outbox e
   WHERE e.dispatched_at IS NULL
   ORDER BY e.created_at
   LIMIT batch
     FOR UPDATE SKIP LOCKED
$$;

CREATE FUNCTION orders.mark_events_dispatched(event_ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE orders.outbox SET dispatched_at = now() WHERE event_id = ANY(event_ids)
$$;

-- Clears the dispatch mark of Pending orders' events dispatched longer ago than `stale_after`,
-- so the dispatcher enqueues them again under the same event id; returns how many.
CREATE FUNCTION orders.requeue_stale_pending(stale_after interval) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH requeued AS (
    UPDATE orders.outbox AS event
       SET dispatched_at = NULL
      FROM orders.orders AS o
     WHERE o.tenant_id = event.tenant_id
       AND o.id = event.order_id
       AND o.status = 'PENDING'
       AND event.dispatched_at < now() - stale_after
    RETURNING 1
  )
  SELECT count(*)::integer FROM requeued
$$;

CREATE FUNCTION orders.oldest_pending_age_seconds() RETURNS double precision
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at))::double precision, 0)
    FROM orders.orders
   WHERE status = 'PENDING'
$$;

REVOKE ALL ON FUNCTION orders.claim_undispatched_events(integer), orders.mark_events_dispatched(uuid[]),
  orders.requeue_stale_pending(interval), orders.oldest_pending_age_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.claim_undispatched_events(integer), orders.mark_events_dispatched(uuid[]),
  orders.requeue_stale_pending(interval), orders.oldest_pending_age_seconds() TO order_app;

-- The order identity reaches the outbox across tenants only through those functions; it keeps
-- appending events for its own tenant at Checkout.
REVOKE SELECT, UPDATE (dispatched_at) ON orders.outbox FROM order_app;

-- migrate:down
GRANT SELECT, UPDATE (dispatched_at) ON orders.outbox TO order_app;
DROP FUNCTION orders.oldest_pending_age_seconds();
DROP FUNCTION orders.requeue_stale_pending(interval);
DROP FUNCTION orders.mark_events_dispatched(uuid[]);
DROP FUNCTION orders.claim_undispatched_events(integer);
DROP POLICY tenant_isolation ON orders.order_events;
DROP POLICY tenant_isolation ON orders.outbox;
DROP POLICY tenant_isolation ON orders.order_items;
DROP POLICY tenant_isolation ON orders.orders;
ALTER TABLE orders.order_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders.outbox DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders.order_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders.orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders.order_events
  DROP CONSTRAINT order_events_tenant_order_to_status_key,
  DROP CONSTRAINT order_events_order_fkey,
  ADD CONSTRAINT order_events_order_id_to_status_key UNIQUE (order_id, to_status),
  ADD CONSTRAINT order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders.orders (id);
ALTER TABLE orders.outbox
  DROP CONSTRAINT outbox_order_fkey,
  ADD CONSTRAINT outbox_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders.orders (id);
ALTER TABLE orders.order_items
  DROP CONSTRAINT order_items_order_fkey,
  DROP CONSTRAINT order_items_pkey,
  ADD PRIMARY KEY (order_id, product_id),
  ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders.orders (id);
ALTER TABLE orders.orders
  DROP CONSTRAINT orders_tenant_id_id_key,
  DROP CONSTRAINT orders_tenant_source_cart_key,
  DROP CONSTRAINT orders_tenant_checkout_key_key,
  ADD CONSTRAINT orders_source_cart_id_key UNIQUE (source_cart_id),
  ADD CONSTRAINT orders_checkout_key_key UNIQUE (checkout_key);
ALTER TABLE orders.order_events DROP COLUMN tenant_id;
ALTER TABLE orders.outbox DROP COLUMN tenant_id;
ALTER TABLE orders.order_items DROP COLUMN tenant_id;
ALTER TABLE orders.orders DROP COLUMN tenant_id;
DROP FUNCTION orders.current_tenant();
