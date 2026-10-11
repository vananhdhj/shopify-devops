-- migrate:up
-- Deleting a shop from this cell: the control plane's lifecycle worker calls this through the
-- order service's purge endpoint. A narrow function (ADR-0012's pattern) instead of DELETE rights for
-- the order identity: it removes exactly one tenant's rows, in dependency order, and reports what it
-- removed and what of the tenant is left in every orders table.
CREATE FUNCTION orders.purge_tenant(t uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  n_order_events integer;
  n_outbox integer;
  n_order_items integer;
  n_orders_removed integer;
BEGIN
  DELETE FROM orders.order_events WHERE tenant_id = t;
  GET DIAGNOSTICS n_order_events = ROW_COUNT;
  DELETE FROM orders.outbox WHERE tenant_id = t;
  GET DIAGNOSTICS n_outbox = ROW_COUNT;
  DELETE FROM orders.order_items WHERE tenant_id = t;
  GET DIAGNOSTICS n_order_items = ROW_COUNT;
  DELETE FROM orders.orders WHERE tenant_id = t;
  GET DIAGNOSTICS n_orders_removed = ROW_COUNT;
  RETURN jsonb_build_object(
    'deleted', jsonb_build_object(
      'orders.order_events', n_order_events,
      'orders.outbox', n_outbox,
      'orders.order_items', n_order_items,
      'orders.orders', n_orders_removed),
    'remaining', jsonb_build_object(
      'orders.order_events', (SELECT count(*) FROM orders.order_events WHERE tenant_id = t),
      'orders.outbox', (SELECT count(*) FROM orders.outbox WHERE tenant_id = t),
      'orders.order_items', (SELECT count(*) FROM orders.order_items WHERE tenant_id = t),
      'orders.orders', (SELECT count(*) FROM orders.orders WHERE tenant_id = t)));
END;
$$;

REVOKE ALL ON FUNCTION orders.purge_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.purge_tenant(uuid) TO order_app;

-- migrate:down
DROP FUNCTION orders.purge_tenant(uuid);
