---
status: accepted
---

# Migrations expand, and contract only a release later, across the waves

A release reaches the cells one wave at a time (Phase 4). Each cell runs its migration as a Sync hook before its new pods start. So, for a while, the previous release's images run on the new schema:
- in every cell, during its own rollout;
- in the later waves, for as long as the earlier waves soak, behind the control plane and the edge, which went out with wave 0.

A migration may therefore only **expand** the schema: new tables, new nullable columns, columns with defaults, new indexes and functions. A **contract** step removes or tightens what an older image still uses: a drop, a rename, a type change, `SET NOT NULL`, or a `NOT NULL` column without a default. It ships in a later release, once no wave runs an image that uses the old shape. Its file says so with a `-- contract: <why it is safe now>` comment.

CI enforces both halves on every pull request:
- `scripts/migration-lint.py` refuses a destructive statement in a new migration's up section unless the file is marked as a contract step. Its fixtures under `tests/migration-lint/` are checked in the same job. It also refuses any edit to, or removal of, an applied migration.
- The `compat` job (`make compat`) runs the last wave's cell images, pinned on `main` and pulled from GHCR, with the pull request's migrations, control plane, and edge. A shop's whole life then runs through the edge: signup, a Merchant's product, a guest's Checkout to Confirmed, and deletion.

## Considered Options

- **Migrate every cell first, then roll the images** (a separate schema release): rejected. It needs two releases for every schema change anyway, and gives no protection against a schema change that breaks the running images.
- **A lint alone**: rejected. It recognises statements, not meaning. A new `CHECK`, a trigger, or a function change can break the previous images in ways no pattern sees. The `compat` job runs the real previous images.
- **A `compat` job alone**: rejected. It exercises only the paths its test walks; the lint catches the common destructive statements wherever they are.

## Consequences

- A rename takes three releases: add the new column and write both; switch the reads and stop writing the old one; drop the old one (the contract step).
- `compat` tests the oldest images the fleet runs (the last wave's), not every pair of versions. Two releases in flight at once (wave 0 on the newest, wave 2 two releases back) are covered only if each release was compatible with the one before it.
- Manifests are not waved: they reach every cell at the merge. A manifest that needs the new image (a new environment variable read at startup, say) breaks the cells still on the previous image. That is the same rule as the two-step merge, now for every release.
- Proven once (2026-10-13, locally, not committed):
  - an unmarked `RENAME COLUMN name TO title` on `catalog.products` was refused by the lint;
  - marked as a contract step, it passed the lint, and `compat` then failed: the previous catalog API answered 500, `column "name" of relation "products" does not exist`.
