-- migrate:up
-- The Merchant adds products through the catalog identity: it may insert the descriptive
-- columns and starting Stock, but never set ids, currency, or timestamps itself.
GRANT INSERT (name, description, price_minor, stock) ON catalog.products TO catalog_app;

-- migrate:down
REVOKE INSERT (name, description, price_minor, stock) ON catalog.products FROM catalog_app;
