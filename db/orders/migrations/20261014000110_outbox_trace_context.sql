-- migrate:up
-- Phase 7: one trace from a buyer's Checkout to its settlement. The Checkout's W3C trace context
-- is kept with its outbox event, and the dispatcher reads it back to hand to the queue job. NULL
-- for events written by an earlier order service, or with tracing off. The dispatcher claims
-- events of every tenant through narrow functions (ADR-0012); this one reads their contexts.
ALTER TABLE orders.outbox ADD COLUMN trace_context text CHECK (length(trace_context) <= 512);

CREATE FUNCTION orders.event_trace_contexts(events uuid[]) RETURNS TABLE (event_id uuid, trace_context text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT o.event_id, o.trace_context FROM orders.outbox o WHERE o.event_id = ANY (events) AND o.trace_context IS NOT NULL
$$;
REVOKE ALL ON FUNCTION orders.event_trace_contexts(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.event_trace_contexts(uuid[]) TO order_app;

-- migrate:down
DROP FUNCTION orders.event_trace_contexts(uuid[]);
ALTER TABLE orders.outbox DROP COLUMN trace_context;
