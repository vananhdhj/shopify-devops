-- The two shops of Phase 1, entered into the registry once. Runs on every start but only adds what is
-- missing, so it never undoes a later status change (a suspension, a deletion) or a new password.
-- Their Merchant password hashes come from MERCHANT_CREDENTIALS (psql variables harbor_hash and
-- meadow_hash), so their Merchants keep the passwords they already have.
WITH created AS (
  INSERT INTO platform.tenants (id, handle, name, merchant_password_hash) VALUES
    ('10000000-0000-4000-8000-000000000001', 'harbor', 'Harbor Goods', :'harbor_hash'),
    ('10000000-0000-4000-8000-000000000002', 'meadow', 'Meadow Supply', :'meadow_hash')
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor)
SELECT id, NULL, 'PROVISIONING', 'created', 'seed' FROM created;

WITH activated AS (
  UPDATE platform.tenants SET status = 'ACTIVE', cell = 'cell-1'
   WHERE id IN ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002')
     AND status = 'PROVISIONING'
  RETURNING id
)
INSERT INTO platform.tenant_events (tenant_id, from_status, to_status, step, actor, detail)
SELECT id, 'PROVISIONING', 'ACTIVE', 'activated', 'seed', '{"cell": "cell-1"}' FROM activated;
