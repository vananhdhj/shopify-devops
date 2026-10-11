-- Seed catalogs for the two seeded shops. Re-running resets these products to their seed price
-- and stock. Runs as the migration identity, which owns the tables (row-level security does not
-- apply to it), so every row names its tenant explicitly.
-- In each shop, products with stock 1 exist for last-unit contention tests.

-- Harbor Goods (tenant 10000000-0000-4000-8000-000000000001): the original single-shop catalog.
INSERT INTO catalog.products (tenant_id, id, name, description, price_minor, stock) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Canvas Tote',        'Heavy cotton tote bag.',             1800, 40),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Enamel Mug',         'Speckled enamel camp mug.',          1400, 25),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'Linen Apron',        'Washed linen apron with pocket.',    3600, 15),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'Beeswax Candle',     'Hand-poured, 40 hour burn.',         2200, 30),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'Ceramic Planter',    'Matte glaze, drainage hole.',        2900, 12),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000006', 'Wool Socks',         'Merino blend, one size.',            1600, 50),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000007', 'Notebook Set',       'Three dot-grid notebooks.',          1200, 60),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000008', 'Brass Bottle Opener','Solid brass, keyring loop.',          900, 35),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000009', 'Olive Wood Board',   'Serving board, hand finished.',      4800, 8),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000010', 'Cotton Throw',       'Woven throw blanket.',               6500, 6),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'Last Lantern',       'Signed lantern; only one made.',     9900, 1),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'Final Print',        'Last print of a sold-out edition.',  4500, 1),
-- Meadow Supply (tenant 10000000-0000-4000-8000-000000000002): a smaller garden catalog.
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000101', 'Seed Packet Trio',   'Tomato, basil, and marigold seeds.',  900, 80),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000102', 'Hand Trowel',        'Forged steel, ash handle.',          2400, 20),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000103', 'Watering Can',       'Galvanised, two litres.',            3800, 10),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000104', 'Garden Twine',       'Jute twine, 100 metres.',             700, 45),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000105', 'Heirloom Sundial',   'Restored bronze sundial; only one.', 12000, 1)
ON CONFLICT (id) DO UPDATE SET
  name       = EXCLUDED.name,
  description = EXCLUDED.description,
  price_minor = EXCLUDED.price_minor,
  stock       = EXCLUDED.stock;

DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.products
      WHERE tenant_id = '10000000-0000-4000-8000-000000000001'
        AND id BETWEEN '00000000-0000-4000-8000-000000000001' AND '00000000-0000-4000-8000-000000000012') <> 12 THEN
    RAISE EXCEPTION 'seed check failed: expected 12 Harbor Goods seed products';
  END IF;
  IF (SELECT count(*) FROM catalog.products
      WHERE tenant_id = '10000000-0000-4000-8000-000000000002'
        AND id BETWEEN '00000000-0000-4000-8000-000000000101' AND '00000000-0000-4000-8000-000000000105') <> 5 THEN
    RAISE EXCEPTION 'seed check failed: expected 5 Meadow Supply seed products';
  END IF;
END $$;
