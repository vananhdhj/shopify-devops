-- migrate:up
-- Fair dispatch (Phase 5, decision 1): the dispatcher admits at most `per_tenant` of a tenant's
-- Orders into the cell's one settlement queue at a time, counting those already dispatched and
-- still Pending, and takes tenants round-robin: every tenant's oldest waiting event first, then
-- every tenant's second, and so on. A burst waits in its own tenant's outbox, behind nobody else.
-- The Phase 1 function stays for the previous release's worker (expand/contract, ADR-0021).
CREATE FUNCTION orders.claim_fair_events(batch integer, per_tenant integer)
RETURNS TABLE (event_id uuid, tenant_id uuid, order_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH in_flight AS (
    SELECT e.tenant_id, count(*) AS n
      FROM orders.outbox e
      JOIN orders.orders o ON o.tenant_id = e.tenant_id AND o.id = e.order_id
     WHERE e.dispatched_at IS NOT NULL AND o.status = 'PENDING'
     GROUP BY e.tenant_id
  ),
  waiting AS (
    SELECT e.event_id, e.created_at, row_number() OVER (PARTITION BY e.tenant_id ORDER BY e.created_at) AS place,
           coalesce(f.n, 0) AS dispatched
      FROM orders.outbox e
      LEFT JOIN in_flight f ON f.tenant_id = e.tenant_id
     WHERE e.dispatched_at IS NULL
  ),
  admitted AS (
    SELECT event_id, created_at, place FROM waiting WHERE place + dispatched <= per_tenant
  )
  SELECT e.event_id, e.tenant_id, e.order_id
    FROM orders.outbox e
    JOIN admitted a ON a.event_id = e.event_id
   ORDER BY a.place, a.created_at
   LIMIT batch
     FOR UPDATE OF e SKIP LOCKED
$$;

REVOKE ALL ON FUNCTION orders.claim_fair_events(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.claim_fair_events(integer, integer) TO order_app;

-- migrate:down
DROP FUNCTION orders.claim_fair_events(integer, integer);
