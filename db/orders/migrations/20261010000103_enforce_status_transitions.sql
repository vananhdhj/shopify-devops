-- migrate:up
-- The database itself refuses illegal Order status changes, so no code path (worker, admin
-- endpoint, or a manual query by the order identity) can skip or reverse a state:
--   new Orders are PENDING; PENDING -> CONFIRMED | REJECTED_OUT_OF_STOCK | REJECTED_PAYMENT;
--   CONFIRMED -> FULFILLED. Everything else raises check_violation (SQLSTATE 23514).
CREATE FUNCTION orders.enforce_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'new orders must be PENDING, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status
     OR (OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'REJECTED_OUT_OF_STOCK', 'REJECTED_PAYMENT'))
     OR (OLD.status = 'CONFIRMED' AND NEW.status = 'FULFILLED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal order status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER orders_status_transition
  BEFORE INSERT OR UPDATE OF status ON orders.orders
  FOR EACH ROW EXECUTE FUNCTION orders.enforce_status_transition();

-- migrate:down
DROP TRIGGER orders_status_transition ON orders.orders;
DROP FUNCTION orders.enforce_status_transition();
