-- migrate:up
-- The age of each tenant's oldest Pending Order (Phase 5, the tenant dimension), for the order
-- service's gauge. Across tenants, so through a narrow function returning only ids and ages, like
-- the cell-wide one beside it, which stays for the previous release's order service.
CREATE FUNCTION orders.oldest_pending_by_tenant()
RETURNS TABLE (tenant_id uuid, age_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT tenant_id, EXTRACT(EPOCH FROM now() - min(created_at))::double precision
    FROM orders.orders
   WHERE status = 'PENDING'
   GROUP BY tenant_id
$$;

REVOKE ALL ON FUNCTION orders.oldest_pending_by_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.oldest_pending_by_tenant() TO order_app;

-- migrate:down
DROP FUNCTION orders.oldest_pending_by_tenant();
