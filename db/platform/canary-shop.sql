-- The platform's own synthetic shop: internal, so placement puts it only in the canary cell, where
-- every release lands first (Phase 4 measures it there). Entered once, PROVISIONING and unplaced,
-- with a request to provision it; the lifecycle worker places it as soon as a canary cell has
-- registered. No Merchant signs in to it: its password hash matches no password.
WITH created AS (
  INSERT INTO platform.tenants (id, handle, name, merchant_password_hash, internal) VALUES
    ('10000000-0000-4000-8000-000000000003', 'canary', 'Platform Canary', 'scrypt:00:00', true)
  ON CONFLICT (id) DO NOTHING
  RETURNING id
), audited AS (
  INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
  SELECT id, NULL, 'PROVISIONING', 'created', 'seed', '{"internal": true}' FROM created
)
INSERT INTO platform.lifecycle_outbox (tenant_id, action)
SELECT id, 'provision' FROM created;
