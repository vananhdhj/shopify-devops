-- migrate:up
-- contract: every image since release 1d28dd1 reads title, none reads name (ADR-0021)
ALTER TABLE catalog.products DROP COLUMN name;
-- migrate:down
