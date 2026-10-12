-- Seed catalog of the platform's synthetic shop (tenant 10000000-0000-4000-8000-000000000003), in
-- the canary cell only. Re-running resets the products to their seed price and stock. Runs as the
-- migration identity, which owns the tables, so every row names its tenant explicitly.
INSERT INTO catalog.products (tenant_id, id, name, description, price_minor, stock) VALUES
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000201', 'Canary Probe Mug',   'Bought by the release canary.', 1000, 1000000),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000202', 'Canary Probe Pen',   'Bought by the release canary.',  300, 1000000),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000203', 'Canary Probe Patch', 'Bought by the release canary.',  500, 1000000)
ON CONFLICT (id) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  price_minor = EXCLUDED.price_minor,
  stock       = EXCLUDED.stock;

DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.products WHERE tenant_id = '10000000-0000-4000-8000-000000000003') <> 3 THEN
    RAISE EXCEPTION 'seed check failed: expected 3 canary seed products';
  END IF;
END $$;
