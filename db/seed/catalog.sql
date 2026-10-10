-- Seed catalog. Re-running resets these products to their seed price and stock.
-- The two products with stock 1 exist for last-unit contention tests.
INSERT INTO catalog.products (id, name, description, price_minor, stock) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Canvas Tote',        'Heavy cotton tote bag.',             1800, 40),
  ('00000000-0000-4000-8000-000000000002', 'Enamel Mug',         'Speckled enamel camp mug.',          1400, 25),
  ('00000000-0000-4000-8000-000000000003', 'Linen Apron',        'Washed linen apron with pocket.',    3600, 15),
  ('00000000-0000-4000-8000-000000000004', 'Beeswax Candle',     'Hand-poured, 40 hour burn.',         2200, 30),
  ('00000000-0000-4000-8000-000000000005', 'Ceramic Planter',    'Matte glaze, drainage hole.',        2900, 12),
  ('00000000-0000-4000-8000-000000000006', 'Wool Socks',         'Merino blend, one size.',            1600, 50),
  ('00000000-0000-4000-8000-000000000007', 'Notebook Set',       'Three dot-grid notebooks.',          1200, 60),
  ('00000000-0000-4000-8000-000000000008', 'Brass Bottle Opener','Solid brass, keyring loop.',          900, 35),
  ('00000000-0000-4000-8000-000000000009', 'Olive Wood Board',   'Serving board, hand finished.',      4800, 8),
  ('00000000-0000-4000-8000-000000000010', 'Cotton Throw',       'Woven throw blanket.',               6500, 6),
  ('00000000-0000-4000-8000-000000000011', 'Last Lantern',       'Signed lantern; only one made.',     9900, 1),
  ('00000000-0000-4000-8000-000000000012', 'Final Print',        'Last print of a sold-out edition.',  4500, 1)
ON CONFLICT (id) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  price_minor = EXCLUDED.price_minor,
  stock       = EXCLUDED.stock;

DO $$
BEGIN
  IF (SELECT count(*) FROM catalog.products
      WHERE id BETWEEN '00000000-0000-4000-8000-000000000001' AND '00000000-0000-4000-8000-000000000012') <> 12 THEN
    RAISE EXCEPTION 'seed check failed: expected 12 seed products';
  END IF;
END $$;
