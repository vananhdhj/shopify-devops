-- migrate:up
-- Phase 6: one tenant's catalog rows out of this cell and into another, and a fingerprint of them
-- to prove the two copies equal. Narrow SECURITY DEFINER functions like the purge (ADR-0012): the
-- catalog identity gains no cross-tenant rights. Rows travel as JSON, one array per table, in key
-- order; checksums are md5 over each table's rows in that order, rendered in UTC so two cells agree.
CREATE FUNCTION catalog.export_tenant(t uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
  SELECT jsonb_build_object(
    'catalog.products', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM catalog.products r WHERE r.tenant_id = t),
    'catalog.carts', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM catalog.carts r WHERE r.tenant_id = t),
    'catalog.cart_items', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.cart_id, r.product_id), '[]') FROM catalog.cart_items r WHERE r.tenant_id = t),
    'catalog.inventory_effects', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.order_id, r.action), '[]') FROM catalog.inventory_effects r WHERE r.tenant_id = t))
$$;

CREATE FUNCTION catalog.tenant_checksums(t uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
  SELECT jsonb_object_agg(name, jsonb_build_object('rows', jsonb_array_length(rows), 'md5', md5(rows::text)))
    FROM jsonb_each(catalog.export_tenant(t)) AS e(name, rows)
$$;

-- Inserts an exported tenant's rows, keeping their ids. Refuses rows of another tenant, and a
-- tenant that already has catalog rows here (a move or restore imports into an empty place).
CREATE FUNCTION catalog.import_tenant(t uuid, rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  name text;
BEGIN
  IF EXISTS (SELECT 1 FROM catalog.products WHERE tenant_id = t) OR EXISTS (SELECT 1 FROM catalog.carts WHERE tenant_id = t)
     OR EXISTS (SELECT 1 FROM catalog.inventory_effects WHERE tenant_id = t) THEN
    RAISE EXCEPTION 'tenant % already has catalog rows in this cell', t USING ERRCODE = 'unique_violation';
  END IF;
  FOREACH name IN ARRAY ARRAY['catalog.products', 'catalog.carts', 'catalog.cart_items', 'catalog.inventory_effects'] LOOP
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(rows -> name, '[]')) AS r WHERE (r ->> 'tenant_id')::uuid IS DISTINCT FROM t) THEN
      RAISE EXCEPTION '% holds rows of another tenant', name USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  INSERT INTO catalog.products SELECT * FROM jsonb_populate_recordset(NULL::catalog.products, coalesce(rows -> 'catalog.products', '[]'));
  INSERT INTO catalog.carts SELECT * FROM jsonb_populate_recordset(NULL::catalog.carts, coalesce(rows -> 'catalog.carts', '[]'));
  INSERT INTO catalog.cart_items SELECT * FROM jsonb_populate_recordset(NULL::catalog.cart_items, coalesce(rows -> 'catalog.cart_items', '[]'));
  INSERT INTO catalog.inventory_effects SELECT * FROM jsonb_populate_recordset(NULL::catalog.inventory_effects, coalesce(rows -> 'catalog.inventory_effects', '[]'));
  RETURN catalog.tenant_checksums(t);
END;
$$;

REVOKE ALL ON FUNCTION catalog.export_tenant(uuid), catalog.tenant_checksums(uuid), catalog.import_tenant(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.export_tenant(uuid), catalog.tenant_checksums(uuid), catalog.import_tenant(uuid, jsonb) TO catalog_app;

-- migrate:down
DROP FUNCTION catalog.import_tenant(uuid, jsonb);
DROP FUNCTION catalog.tenant_checksums(uuid);
DROP FUNCTION catalog.export_tenant(uuid);
