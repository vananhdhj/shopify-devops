-- migrate:up
-- The tenant registry: every shop on the platform, its lifecycle status, and where it runs. Owned by
-- the control plane, in its own database: no cell can take it down, and it depends on no cell.
CREATE TABLE platform.tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A single DNS label; unique forever, so a deleted shop's handle is never reused (its row stays
  -- as the anchor of its audit trail).
  handle              text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$'),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status              text NOT NULL DEFAULT 'PROVISIONING'
                      CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED')),
  -- Where the shop's data lives; NULL until provisioning places it.
  cell                text,
  -- scrypt:<salt hex>:<key hex>; never leaves the control plane.
  merchant_password_hash text NOT NULL,
  -- Changes whenever the Merchant credential changes; sessions are bound to it, so bumping it signs
  -- the shop's sessions out. Carried to the cell in the tenant context; not a secret.
  credential_version  integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Signup retries: one idempotency key makes one tenant, judged against a hash of the request, the
-- same rule a Checkout key follows.
CREATE TABLE platform.signups (
  idempotency_key text PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash    text NOT NULL,
  tenant_id       uuid NOT NULL UNIQUE REFERENCES platform.tenants (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Append-only lifecycle audit: who moved a shop, through which step, and when.
CREATE TABLE platform.tenant_events (
  event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants (id),
  from_status text,
  to_status   text,
  step        text NOT NULL,
  actor       text NOT NULL CHECK (actor IN ('seed', 'signup', 'operator', 'platform-worker')),
  detail      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_events_tenant ON platform.tenant_events (tenant_id, created_at);

-- One event per lifecycle request (provision, delete), written in the same transaction as the
-- status change that asks for it; the lifecycle worker claims events with SKIP LOCKED.
CREATE TABLE platform.lifecycle_outbox (
  event_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES platform.tenants (id),
  action        text NOT NULL CHECK (action IN ('provision', 'delete')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  not_before    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lifecycle_outbox_pending ON platform.lifecycle_outbox (not_before) WHERE completed_at IS NULL;

-- The database refuses illegal lifecycle moves, whoever attempts them:
--   new tenants are PROVISIONING; PROVISIONING -> ACTIVE; ACTIVE <-> SUSPENDED;
--   ACTIVE | SUSPENDED -> DELETING; DELETING -> DELETED. Anything else raises check_violation.
CREATE FUNCTION platform.enforce_tenant_transition() RETURNS trigger
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

CREATE TRIGGER tenants_status_transition
  BEFORE INSERT OR UPDATE OF status ON platform.tenants
  FOR EACH ROW EXECUTE FUNCTION platform.enforce_tenant_transition();

-- The runtime identity reads and changes the registry but never alters its structure, and only
-- appends to the audit trail.
GRANT USAGE ON SCHEMA platform TO platform_app;
GRANT SELECT, INSERT ON platform.tenants, platform.signups TO platform_app;
GRANT UPDATE (status, cell, merchant_password_hash, credential_version) ON platform.tenants TO platform_app;
GRANT SELECT, INSERT ON platform.tenant_events TO platform_app;
GRANT SELECT, INSERT, UPDATE (completed_at, attempts, not_before) ON platform.lifecycle_outbox TO platform_app;

-- migrate:down
DROP TRIGGER tenants_status_transition ON platform.tenants;
DROP FUNCTION platform.enforce_tenant_transition();
DROP TABLE platform.lifecycle_outbox;
DROP TABLE platform.tenant_events;
DROP TABLE platform.signups;
DROP TABLE platform.tenants;
