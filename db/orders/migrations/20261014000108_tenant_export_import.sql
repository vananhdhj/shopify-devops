-- migrate:up
-- Phase 6: one tenant's Order rows out of this cell and into another, and their fingerprint (see
-- the catalog's functions of the same names). An imported Order enters PENDING, as the status
-- trigger requires of every new Order, and steps through the allowed transitions to the status it
-- had, so the rule that no Order skips a state holds for imports too.
CREATE FUNCTION orders.export_tenant(t uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
  SELECT jsonb_build_object(
    'orders.orders', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM orders.orders r WHERE r.tenant_id = t),
    'orders.order_items', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.order_id, r.product_id), '[]') FROM orders.order_items r WHERE r.tenant_id = t),
    'orders.order_events', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.event_id), '[]') FROM orders.order_events r WHERE r.tenant_id = t),
    'orders.outbox', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.event_id), '[]') FROM orders.outbox r WHERE r.tenant_id = t))
$$;

CREATE FUNCTION orders.tenant_checksums(t uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
  SELECT jsonb_object_agg(name, jsonb_build_object('rows', jsonb_array_length(rows), 'md5', md5(rows::text)))
    FROM jsonb_each(orders.export_tenant(t)) AS e(name, rows)
$$;

CREATE FUNCTION orders.import_tenant(t uuid, rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  name text;
BEGIN
  IF EXISTS (SELECT 1 FROM orders.orders WHERE tenant_id = t) THEN
    RAISE EXCEPTION 'tenant % already has Orders in this cell', t USING ERRCODE = 'unique_violation';
  END IF;
  FOREACH name IN ARRAY ARRAY['orders.orders', 'orders.order_items', 'orders.order_events', 'orders.outbox'] LOOP
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(rows -> name, '[]')) AS r WHERE (r ->> 'tenant_id')::uuid IS DISTINCT FROM t) THEN
      RAISE EXCEPTION '% holds rows of another tenant', name USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  INSERT INTO orders.orders
    SELECT (jsonb_populate_record(NULL::orders.orders, r || '{"status": "PENDING"}')).*
      FROM jsonb_array_elements(coalesce(rows -> 'orders.orders', '[]')) AS r;
  UPDATE orders.orders o SET status = 'CONFIRMED'
    FROM jsonb_array_elements(coalesce(rows -> 'orders.orders', '[]')) AS r
   WHERE o.tenant_id = t AND o.id = (r ->> 'id')::uuid AND r ->> 'status' IN ('CONFIRMED', 'FULFILLED');
  UPDATE orders.orders o SET status = 'FULFILLED'
    FROM jsonb_array_elements(coalesce(rows -> 'orders.orders', '[]')) AS r
   WHERE o.tenant_id = t AND o.id = (r ->> 'id')::uuid AND r ->> 'status' = 'FULFILLED';
  UPDATE orders.orders o SET status = r ->> 'status'
    FROM jsonb_array_elements(coalesce(rows -> 'orders.orders', '[]')) AS r
   WHERE o.tenant_id = t AND o.id = (r ->> 'id')::uuid AND r ->> 'status' IN ('REJECTED_OUT_OF_STOCK', 'REJECTED_PAYMENT');
  INSERT INTO orders.order_items SELECT * FROM jsonb_populate_recordset(NULL::orders.order_items, coalesce(rows -> 'orders.order_items', '[]'));
  INSERT INTO orders.order_events SELECT * FROM jsonb_populate_recordset(NULL::orders.order_events, coalesce(rows -> 'orders.order_events', '[]'));
  INSERT INTO orders.outbox SELECT * FROM jsonb_populate_recordset(NULL::orders.outbox, coalesce(rows -> 'orders.outbox', '[]'));
  RETURN orders.tenant_checksums(t);
END;
$$;

REVOKE ALL ON FUNCTION orders.export_tenant(uuid), orders.tenant_checksums(uuid), orders.import_tenant(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.export_tenant(uuid), orders.tenant_checksums(uuid), orders.import_tenant(uuid, jsonb) TO order_app;

-- migrate:down
DROP FUNCTION orders.import_tenant(uuid, jsonb);
DROP FUNCTION orders.tenant_checksums(uuid);
DROP FUNCTION orders.export_tenant(uuid);
