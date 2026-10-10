-- migrate:up
-- The shop sells in one currency: Cart subtotals add line totals together, which is only
-- meaningful if every Product shares it. Enforced here so it can't silently drift.
ALTER TABLE catalog.products
  ADD CONSTRAINT products_single_shop_currency CHECK (currency = 'USD');

-- migrate:down
ALTER TABLE catalog.products DROP CONSTRAINT products_single_shop_currency;
