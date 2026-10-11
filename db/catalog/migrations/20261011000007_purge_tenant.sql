-- migrate:up
-- Deleting a shop from this cell: the control plane's lifecycle worker calls this through the
-- catalog's purge endpoint. A narrow function (ADR-0012's pattern) instead of DELETE rights for
-- the runtime identity: it removes exactly one tenant's rows, in dependency order, and reports what it
-- removed and what of the tenant is left in every catalog table.
CREATE FUNCTION catalog.purge_tenant(t uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  n_cart_items integer;
  n_carts integer;
  n_effects integer;
  n_products integer;
BEGIN
  DELETE FROM catalog.cart_items WHERE tenant_id = t;
  GET DIAGNOSTICS n_cart_items = ROW_COUNT;
  DELETE FROM catalog.carts WHERE tenant_id = t;
  GET DIAGNOSTICS n_carts = ROW_COUNT;
  DELETE FROM catalog.inventory_effects WHERE tenant_id = t;
  GET DIAGNOSTICS n_effects = ROW_COUNT;
  DELETE FROM catalog.products WHERE tenant_id = t;
  GET DIAGNOSTICS n_products = ROW_COUNT;
  RETURN jsonb_build_object(
    'deleted', jsonb_build_object(
      'catalog.cart_items', n_cart_items,
      'catalog.carts', n_carts,
      'catalog.inventory_effects', n_effects,
      'catalog.products', n_products),
    'remaining', jsonb_build_object(
      'catalog.cart_items', (SELECT count(*) FROM catalog.cart_items WHERE tenant_id = t),
      'catalog.carts', (SELECT count(*) FROM catalog.carts WHERE tenant_id = t),
      'catalog.inventory_effects', (SELECT count(*) FROM catalog.inventory_effects WHERE tenant_id = t),
      'catalog.products', (SELECT count(*) FROM catalog.products WHERE tenant_id = t)));
END;
$$;

REVOKE ALL ON FUNCTION catalog.purge_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.purge_tenant(uuid) TO catalog_app;

-- migrate:down
DROP FUNCTION catalog.purge_tenant(uuid);
