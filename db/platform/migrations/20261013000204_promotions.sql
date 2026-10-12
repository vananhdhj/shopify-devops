-- migrate:up
-- Phase 4: the promoter's record of every release it soaked in a wave. A release is the set of
-- image digests the wave's cells run ({"<image>": "sha256:…"}); `release_key` is its sorted text,
-- so a release is soaked in a wave once, and a halted release is never promoted from that wave.
--   soaking     the wave runs the release; the gate is being checked until the soak ends
--   promoting   the gate passed and the promote workflow was dispatched for the next wave
--   promoted    the next wave runs the release
--   halted      a gate check failed; the operator reverts, nothing is retried
--   superseded  the wave moved to another release before the soak ended
CREATE TABLE platform.promotions (
  id               bigserial PRIMARY KEY,
  release_key      text NOT NULL,
  digests          jsonb NOT NULL,
  wave             integer NOT NULL CHECK (wave >= 0),
  cells            text[] NOT NULL,
  state            text NOT NULL CHECK (state IN ('soaking', 'promoting', 'promoted', 'halted', 'superseded')),
  soak_started_at  timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz,
  decided_at       timestamptz,
  -- The gate's running observations: checks passed and failed so far, the last failure.
  gate             jsonb NOT NULL DEFAULT '{}',
  -- On a halt: the cells that ran the release, and the real (not internal) shops they held.
  exposed_cells    text[],
  exposed_tenants  integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_key, wave)
);

CREATE TABLE platform.promotion_events (
  id            bigserial PRIMARY KEY,
  promotion_id  bigint NOT NULL REFERENCES platform.promotions (id),
  step          text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX promotion_events_promotion ON platform.promotion_events (promotion_id, created_at);

GRANT SELECT, INSERT ON platform.promotions, platform.promotion_events TO platform_app;
GRANT UPDATE (state, dispatched_at, decided_at, gate, exposed_cells, exposed_tenants, updated_at) ON platform.promotions TO platform_app;
GRANT USAGE ON SEQUENCE platform.promotions_id_seq, platform.promotion_events_id_seq TO platform_app;

-- migrate:down
DROP TABLE platform.promotion_events;
DROP TABLE platform.promotions;
