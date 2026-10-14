-- migrate:up
-- Phase 6: a Merchant deletes a product from their catalog (the destructive action a restore
-- undoes). The catalog identity still has no DELETE of its own (ADR-0012, ADR-0016): one narrow
-- function deletes one product of the transaction's tenant (app.tenant_id, as row-level security
-- uses), out of every Cart first. Orders keep their own lines. False when there is none.
CREATE FUNCTION catalog.delete_product(p uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  n integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'no tenant in this transaction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM catalog.cart_items WHERE tenant_id = t AND product_id = p;
  DELETE FROM catalog.products WHERE tenant_id = t AND id = p;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

REVOKE ALL ON FUNCTION catalog.delete_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.delete_product(uuid) TO catalog_app;

-- migrate:down
DROP FUNCTION catalog.delete_product(uuid);
