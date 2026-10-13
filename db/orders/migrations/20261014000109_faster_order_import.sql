-- migrate:up
-- Phase 6: the same Order import (20261014000108), with its status steps as index lookups. An
-- imported Order still enters PENDING and steps through allowed transitions: CONFIRMED (for
-- CONFIRMED and FULFILLED Orders), then FULFILLED, then the two rejections, each from PENDING.
CREATE OR REPLACE FUNCTION orders.import_tenant(t uuid, rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  name text;
  step text;
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
  -- Each step looks the Orders up by an array of their ids (an index scan): a join on ids read
  -- out of the JSON compared every Order with every exported row, seconds for a few thousand.
  FOREACH step IN ARRAY ARRAY['CONFIRMED', 'FULFILLED', 'REJECTED_OUT_OF_STOCK', 'REJECTED_PAYMENT'] LOOP
    UPDATE orders.orders SET status = step
     WHERE tenant_id = t
       AND id = ANY (ARRAY(
         SELECT (r ->> 'id')::uuid FROM jsonb_array_elements(coalesce(rows -> 'orders.orders', '[]')) AS r
          WHERE r ->> 'status' = step OR (step = 'CONFIRMED' AND r ->> 'status' = 'FULFILLED')));
  END LOOP;
  INSERT INTO orders.order_items SELECT * FROM jsonb_populate_recordset(NULL::orders.order_items, coalesce(rows -> 'orders.order_items', '[]'));
  INSERT INTO orders.order_events SELECT * FROM jsonb_populate_recordset(NULL::orders.order_events, coalesce(rows -> 'orders.order_events', '[]'));
  INSERT INTO orders.outbox SELECT * FROM jsonb_populate_recordset(NULL::orders.outbox, coalesce(rows -> 'orders.outbox', '[]'));
  RETURN orders.tenant_checksums(t);
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION orders.import_tenant(t uuid, rows jsonb) RETURNS jsonb
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
