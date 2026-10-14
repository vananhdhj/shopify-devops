-- migrate:up
-- Phase 6: per-tenant exports and restores (decision 3: restore points are scheduled exports; PITR
-- is deferred). The platform worker writes each export to its volume and records it here, so the
-- API lists exports without the volume; a restore re-imports one, resumable like a move.
ALTER TABLE platform.lifecycle_outbox
  DROP CONSTRAINT lifecycle_outbox_action_check,
  ADD CONSTRAINT lifecycle_outbox_action_check CHECK (action IN ('provision', 'delete', 'move', 'export', 'restore'));
-- An operator's export goes before a round of scheduled ones (1 against 0).
ALTER TABLE platform.lifecycle_outbox ADD COLUMN priority smallint NOT NULL DEFAULT 0;

CREATE TABLE platform.tenant_exports (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES platform.tenants (id),
  -- scheduled (every EXPORT_INTERVAL), on-demand (the operator), pre-restore (a restore's safety copy).
  kind       text NOT NULL CHECK (kind IN ('scheduled', 'on-demand', 'pre-restore')),
  cell       text NOT NULL,
  -- Relative to the worker's export directory: <tenant>/<timestamp>.json.
  file       text NOT NULL UNIQUE,
  bytes      bigint NOT NULL CHECK (bytes >= 0),
  -- Each table's rows and md5, as the cell computed them at the export.
  checksums  jsonb NOT NULL,
  taken_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_exports_tenant ON platform.tenant_exports (tenant_id, taken_at DESC);

CREATE TABLE platform.tenant_restores (
  event_id        uuid PRIMARY KEY REFERENCES platform.lifecycle_outbox (event_id),
  tenant_id       uuid NOT NULL REFERENCES platform.tenants (id),
  -- The export restored, and the safety copy of the shop taken just before; kept while the
  -- restore is open (pruning skips them), NULL once pruned after.
  export_id       uuid REFERENCES platform.tenant_exports (id) ON DELETE SET NULL,
  saved_export_id uuid REFERENCES platform.tenant_exports (id) ON DELETE SET NULL,
  cell            text NOT NULL,
  --   frozen -> saved -> done: restored;
  --   frozen -> undone: failed before any change; saved -> undoing -> undone: put back as it was.
  step            text NOT NULL DEFAULT 'frozen' CHECK (step IN ('frozen', 'saved', 'done', 'undoing', 'undone')),
  reason          text,
  frozen_at       timestamptz NOT NULL DEFAULT now(),
  unfrozen_at     timestamptz,
  finished_at     timestamptz
);
CREATE UNIQUE INDEX tenant_restores_one_open ON platform.tenant_restores (tenant_id) WHERE finished_at IS NULL;

GRANT SELECT, INSERT, DELETE ON platform.tenant_exports TO platform_app;
GRANT SELECT, INSERT ON platform.tenant_restores TO platform_app;
GRANT UPDATE (saved_export_id, step, reason, unfrozen_at, finished_at) ON platform.tenant_restores TO platform_app;

-- migrate:down
DROP TABLE platform.tenant_restores;
DROP TABLE platform.tenant_exports;
ALTER TABLE platform.lifecycle_outbox DROP COLUMN priority;
ALTER TABLE platform.lifecycle_outbox
  DROP CONSTRAINT lifecycle_outbox_action_check,
  ADD CONSTRAINT lifecycle_outbox_action_check CHECK (action IN ('provision', 'delete', 'move'));
