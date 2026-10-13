-- migrate:up
-- Phase 6: a tenant move between cells, run by the lifecycle worker (outbox action `move`). One
-- row per move holds where it goes and the last step it finished, so a worker that crashes
-- resumes from there; every step is also an event in the shop's audit trail.
ALTER TABLE platform.lifecycle_outbox
  DROP CONSTRAINT lifecycle_outbox_action_check,
  ADD CONSTRAINT lifecycle_outbox_action_check CHECK (action IN ('provision', 'delete', 'move'));

CREATE TABLE platform.tenant_moves (
  event_id     uuid PRIMARY KEY REFERENCES platform.lifecycle_outbox (event_id),
  tenant_id    uuid NOT NULL REFERENCES platform.tenants (id),
  source_cell  text NOT NULL,
  target_cell  text NOT NULL REFERENCES platform.cells (id),
  -- The shop's plan once it is in the target (plus for a dedicated cell).
  plan_after   text NOT NULL CHECK (plan_after IN ('starter', 'plus')),
  --   frozen -> verified -> switched -> done: the move went through;
  --   frozen | verified -> undoing -> undone: it was undone before the switch, the shop unfrozen.
  step         text NOT NULL DEFAULT 'frozen'
               CHECK (step IN ('frozen', 'verified', 'switched', 'done', 'undoing', 'undone')),
  -- Each table's rows and md5 as exported from the source and verified in the target.
  checksums    jsonb,
  reason       text,
  frozen_at    timestamptz NOT NULL DEFAULT now(),
  unfrozen_at  timestamptz,
  finished_at  timestamptz,
  CHECK (source_cell <> target_cell)
);
-- At most one unfinished move per shop, and placements count a move's target as taken.
CREATE UNIQUE INDEX tenant_moves_one_open ON platform.tenant_moves (tenant_id) WHERE finished_at IS NULL;
CREATE INDEX tenant_moves_open_target ON platform.tenant_moves (target_cell) WHERE finished_at IS NULL;

GRANT SELECT, INSERT ON platform.tenant_moves TO platform_app;
GRANT UPDATE (step, checksums, reason, unfrozen_at, finished_at) ON platform.tenant_moves TO platform_app;
-- A move into a dedicated cell makes the shop plus.
GRANT UPDATE (plan) ON platform.tenants TO platform_app;

-- migrate:down
REVOKE UPDATE (plan) ON platform.tenants FROM platform_app;
DROP TABLE platform.tenant_moves;
ALTER TABLE platform.lifecycle_outbox
  DROP CONSTRAINT lifecycle_outbox_action_check,
  ADD CONSTRAINT lifecycle_outbox_action_check CHECK (action IN ('provision', 'delete'));
