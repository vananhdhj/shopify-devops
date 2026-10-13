# Spec: Phase 4 — wave delivery

**Status:** resolved (2026-10-13: tickets 01–07 resolved; PRs #35–#38 and #40–#46 merged and deployed to the lab cluster (#39, Argo CD's probes, applied by helm and awaiting merge); the bad-release drill halted at wave 0 with 0 tenants exposed)

Background: the blueprint (`~/workspace/Research/narrow/Shopify DevOps Portfolio Blueprint.md`) puts Phase 4 after the cells: "Wave delivery: canary cell, promotion job with gates, expand/contract migrations, mixed-version CI job". Its exit gate: "A bad release halts at wave 0 with the exposed-tenant count recorded; Git revert restores the canary." Phases 1–3 are resolved, and ADRs 0001–0020 are binding.

Lessons that shape this phase:
- Dependencies deploy before their dependents.
- Manifests must work with the previous image during the window between the merge commit and the digest commit.
- `make secrets` runs before a merge that reads a new key.
- Rollouts of single-replica units cost seconds of errors (Phase 3 evidence). A gate that reads error ratios would trip over its own rollout.
- Add cells to a live node one at a time. The host's memory limits the lab.

## Problem Statement

Every release reaches every cell at once. The release workflow pins each new digest in every cell's directory in one commit, so a bad image breaks the canary, the pooled cell, and the dedicated cell together. Phase 0's bad-release drill showed the alert firing only after every tenant was already exposed. Nothing checks a release in one cell before the next gets it. No record says which tenants ran a bad digest. A schema change can also break the previous image, and nothing tests that.

## Solution

Releases move through the cells in **waves**:
- wave 0: the canary cell, together with the control plane and the edge;
- wave 1: the pooled cells;
- wave 2: the dedicated cells.

The release workflow pins new digests in wave 0 only. A **promoter** in the cluster moves a release on to the next wave. It waits for the wave to sync and become healthy, **soaks** it, and checks a **gate**:
- each cell's error ratio and oldest-Pending age stay under thresholds;
- no alert fires for the cell;
- a **synthetic shop** in each cell completes checkouts throughout the soak.

When the gate passes, the promotion is one Git commit to the next wave's cell directories. When it fails, promotion halts. The promoter records the digest, the cells, and how many tenants ran it, and the operator reverts.

Migrations follow expand/contract, enforced in CI, and a CI job runs the previous release's cell images against the new schema and the new control plane.

## Decisions

Decisions 1–4 were approved on 2026-10-12, decision 5 on 2026-10-13.

1. **A promotion job, not Argo CD progressive syncs.**
   - Progressive syncs (RollingSync) are Beta in the pinned Argo CD v3.5.4. They advance on Application health only, with no soak and no metrics gate. They turn off automated sync on every generated Application. Every cell tracks the same `main` revision, so they leave no record in Git of which wave runs what.
   - With a promotion job, every wave's version is a commit, and rollback is a revert of one commit (ADR-0003's model).
2. **The promoter runs in the cluster.** It is a loop in the platform image (no new image), deployed in `platform-dev`.
   - It reads Argo CD's Applications, Prometheus, and the registry, and checks out through the edge.
   - Merge → canary → waves happens with no human step. GitHub-hosted runners cannot reach the lab's Prometheus, so the gate cannot run in Actions.
3. **A synthetic shop in every cell.** Each registered cell gets one internal shop, created by the control plane when the cell registers.
   - Internal shops do not count against a cell's capacity, so a dedicated cell still takes one plus shop.
   - The canary's existing synthetic shop (`canary`) becomes that cell's synthetic shop.
   - This also covers Phase 5's "one synthetic tenant per cell".
4. **A failed gate halts, and the operator reverts.**
   - The promoter stops promoting that release and records the digest, the wave's cells, and the number of real tenants they hold.
   - An alert (`PromotionHalted`) fires.
   - The operator reverts the release's merge commit, so the next release puts the canary back on good code.
   - The promoter never reverts by itself: a flaky gate on this host must not revert good releases.
5. **Refined while writing (approved 2026-10-13): the promoter asks GitHub to commit, it does not push.**
   - ADR-0003 requires exactly one write deploy key: the ruleset's bypass covers every deploy key. It also rejected Image Updater for putting Git write credentials in the cluster.
   - So the promoter does not hold a deploy key. It starts a `promote` workflow (`workflow_dispatch`) with the wave and the digests it gated. It holds only a fine-grained token limited to *Actions: write* on this repository.
   - The workflow checks out `main` and checks that wave 0 still pins exactly those digests. It then copies them into the wave's cell directories and pushes with the existing deploy key.
   - A stolen token can start workflows, but it cannot write code or move a digest that wave 0 does not already run.
   - Alternative: give the promoter a second write deploy key. Rejected: it adds a second identity that bypasses branch protection, and it puts that identity in the cluster.
   - The operator can also start the workflow by hand: the fallback when the promoter is down.

## User Stories

1. As the platform operator, a merged release reaches the canary cell, the control plane, and the edge first, and the other cells only after their previous wave passed its gate.
2. As the platform operator, `make fleet` shows each cell's wave, the release it runs, and the state of the current promotion (soaking, gated, halted).
3. As the platform operator, a bad release halts at wave 0. I see which digest, which cells, and how many tenants ran it, and the alert reaches me.
4. As the platform operator, reverting the bad release's merge commit restores the canary through the normal release path.
5. As a merchant in the pooled or dedicated cells, a release that fails in the canary never reaches my shop.
6. As a developer, CI refuses a migration that would break the previous image unless it is marked as a contract step, and it runs the previous release's cell images against my new schema and control plane.
7. As the platform operator, a rollout of a cell causes no failed buyer request, so the gate measures the release, not the rollout.

## Implementation Decisions

- **Waves in Git:**
  - Each cell's `cell.json` gains `wave` (0 canary, 1 pooled, 2 dedicated).
  - The release workflow pins new digests in wave 0's cell directories and in the control plane's and the edge's overlays only.
  - A new unit's first digest goes into every cell, as today: no cell may lack an image its manifests reference.
- **Promotion commits:**
  - `.github/workflows/promote.yml` (`workflow_dispatch`: `wave`, `digests` JSON, `gate` summary) copies the gated digests into every cell of `wave`, after checking that wave `wave - 1` pins exactly those digests on `main`.
  - Commit message: `deploy(dev): promote <short digests> to wave <n> (<cells>)`.
  - The commit touches only `deploy/**`, so no release run starts. Promotions run one at a time (a concurrency group).
- **Promoter** (`platform-promoter`, the platform image's `promoter-server.js`, one replica):
  - Every 15 s it reads each cell Application's sync and health status, revision, and images (a Role allowing it to read Applications in `argocd`), and groups the cells by wave from their labels.
  - When every cell of wave *n* runs the same set of digests and wave *n+1* does not, it **soaks** wave *n* for `SOAK_SECONDS` (default 300). During the soak it runs a synthetic checkout in each cell of the wave every 15 s, through the edge (`Host: <synthetic handle>.<domain>`), using the decline payment scenario so Stock is unchanged.
  - The **gate** passes when every cell of wave *n*, through the whole soak:
    - stays Synced and Healthy on those digests;
    - keeps its 5xx ratio (the alert's expression, scoped to the cell's namespace) at or under 5%;
    - keeps its oldest-Pending age at or under 60 s;
    - has no firing alert;
    - has every synthetic Order reach a terminal state within 30 s.
  - A passed gate dispatches `promote.yml` for wave *n+1*. A failed gate halts that digest set.
  - State is a `platform.promotions` table: release digests, wave, state (`soaking`, `promoted`, `halted`), timestamps, gate results, exposed cells and tenant count. Every change is also an event in `platform.promotion_events`. The table makes the promoter restart-safe: it resumes a soak instead of starting over, and never promotes a digest set twice.
  - Metrics: `promotion_state{wave}` and `promotion_gate_checks_total{wave,check,outcome}`. Alert `PromotionHalted`.
- **Synthetic shops:**
  - A cell's registration ensures its internal shop exists: handle `synthetic-<cell>` (the canary keeps `canary`), placed in that cell directly, and provisioned through the outbox.
  - `place()` and the capacity check count only non-internal shops.
  - The cell's catalog API gets an internal endpoint, called by provisioning with the cell's own token, that ensures the synthetic shop has one product with plenty of Stock.
  - The handle prefix `synthetic-` is reserved at signup.
- **Rollouts without errors** (a prerequisite for the gate):
  - Every unit gets a `preStop` delay longer than the endpoint propagation to Traefik, and readiness is draining (service-kit already fails readiness on SIGTERM).
  - Deployments roll with `maxUnavailable: 0`.
  - A probe through the ingress during a rollout of every cell unit must record no failed request.
- **Expand/contract:**
  - CI refuses a migration containing a destructive statement (`DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL`, a new `NOT NULL` column without a default) unless it carries a `-- contract:` comment naming the release after which it is safe.
  - An ADR records the rule.
- **Mixed-version CI job** (`compat`, part of `ci-ok`):
  - Builds the PR's db-migrations, platform, and router images.
  - Runs them with the cell service images pinned on `main` for wave 1 (pulled from GHCR, so the previous release), applies the new migrations, and runs a compatibility subset of the integration suite: signup to an active shop, browse, checkout to Confirmed, Merchant sign-in, and deletion.
- **Fleet view:** `GET /operator/cells` adds each cell's wave. `make fleet` adds the wave column, the current promotion and its state from `GET /operator/promotions`, and each cell's schema version (the latest applied migration, read by the cell's own API on `/internal/schema-version` with the cell's token).

## Testing Decisions

- Unit-level: the gate's decision from a set of observations (a pure function), the promoter's state machine (soak start, resume after restart, promote once, halt), and the migration lint's statement detection.
- Seam 1 (Compose): synthetic shops created on registration and not counted against capacity (a dedicated cell with its synthetic shop still takes one plus shop); the synthetic catalog endpoint only for the cell's own token; the promoter against a fake Argo CD and Prometheus (an HTTP stub), so the gate and halting are tested without a cluster.
- CI: `compat` on every pull request; the migration lint on every pull request.
- Seam 2 (lab cluster):
  - A normal release promoted through waves 0 → 1 → 2, with timings.
  - A rollout with zero failed requests.
  - The bad-release drill: a release whose checkout fails, merged. It halts at wave 0, `PromotionHalted` fires, and the record shows 0 real tenants exposed (the canary holds only the synthetic shop). Reverting the merge commit restores the canary, and the next release promotes through every wave.

## Out of Scope

- Tenant moves between cells (Phase 6).
- Rate limits and queue fairness (Phase 5).
- A 503 page for a shop whose cell's APIs are down (Phase 3 follow-up; Phase 5 alongside the error-ratio work).
- Waves for the staging environment: it keeps its manual pins.
- Automatic reverts.
- More than one cell per wave in the lab: the code handles several, but adding cells waits for the host.
