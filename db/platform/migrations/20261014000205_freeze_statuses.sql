-- migrate:up
-- Phase 6: a shop frozen for a move or a restore. MOVING and RESTORING are reached from ACTIVE and
-- return to it; the edge serves both read-only. Widening only: the previous control plane never
-- writes them, and its edge would answer a shop it does not know the status of as absent, which is
-- why a freeze waits for a release that has this edge (the ticket order).
ALTER TABLE platform.tenants
  DROP CONSTRAINT tenants_status_check,
  ADD CONSTRAINT tenants_status_check
    CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'MOVING', 'RESTORING', 'DELETING', 'DELETED'));

--   new tenants are PROVISIONING; PROVISIONING -> ACTIVE; ACTIVE <-> SUSPENDED; ACTIVE <-> MOVING;
--   ACTIVE <-> RESTORING; ACTIVE | SUSPENDED -> DELETING; DELETING -> DELETED.
CREATE OR REPLACE FUNCTION platform.enforce_tenant_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PROVISIONING' THEN
      RAISE EXCEPTION 'new tenants must be PROVISIONING, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status
     OR (OLD.status = 'PROVISIONING' AND NEW.status = 'ACTIVE')
     OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'MOVING', 'RESTORING', 'DELETING'))
     OR (OLD.status IN ('SUSPENDED', 'MOVING', 'RESTORING') AND NEW.status = 'ACTIVE')
     OR (OLD.status = 'SUSPENDED' AND NEW.status = 'DELETING')
     OR (OLD.status = 'DELETING' AND NEW.status = 'DELETED') THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal tenant status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION platform.enforce_tenant_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PROVISIONING' THEN
      RAISE EXCEPTION 'new tenants must be PROVISIONING, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status
     OR (OLD.status = 'PROVISIONING' AND NEW.status = 'ACTIVE')
     OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'DELETING'))
     OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'DELETING'))
     OR (OLD.status = 'DELETING' AND NEW.status = 'DELETED') THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal tenant status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END;
$$;

ALTER TABLE platform.tenants
  DROP CONSTRAINT tenants_status_check,
  ADD CONSTRAINT tenants_status_check
    CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED'));
