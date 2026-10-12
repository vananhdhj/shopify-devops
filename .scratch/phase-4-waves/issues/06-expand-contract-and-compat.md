# 06: Expand/contract migrations and the mixed-version job

**What to build:** CI keeps the previous release working on the new schema. A lint refuses destructive migration statements unless marked as a contract step, and a `compat` job runs the previous release's cell images against the new migrations, control plane, and edge.

**Blocked by:** none

**Status:** in review

- [ ] `scripts/migration-lint.sh` over migrations new in the PR (both databases): `DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL`, `ADD COLUMN … NOT NULL` without `DEFAULT` refused unless the file has `-- contract: <reason and the release after which it is safe>`; tested against fixtures
- [ ] `compat` job (in `ci-ok`): the PR's db-migrations, platform, and router images built; the cell service images pinned on `main` for wave 1 pulled from GHCR; a Compose override runs them together; a compatibility subset of the integration suite (signup to active, browse, checkout to Confirmed, Merchant sign-in, deletion)
- [ ] ADR: expand/contract across waves
- [ ] Proven once: a PR with a deliberately breaking migration fails the lint, and one that breaks an old image fails `compat` (recorded in the ticket, not merged)

## Comments

Implementation notes (2026-10-13):
- `scripts/migration-lint.py` (Python, not shell: it splits statements, and the purge functions' plpgsql bodies hold semicolons). Only a migration's up section counts; dollar-quoted bodies, comments, and string literals are ignored. Refused: `DROP TABLE|SCHEMA|VIEW|FUNCTION|PROCEDURE|TYPE|SEQUENCE`, an `ALTER TABLE … DROP [COLUMN]` (dropping a constraint, default, `NOT NULL`, identity, or expression is allowed), any `RENAME`, `ALTER COLUMN … TYPE`, `SET NOT NULL`, and an added `NOT NULL` column without a default. A file with `-- contract: <why>` is a contract step and is let through.
  - Run over every existing migration, it passes Phases 2 and 3 and flags Phase 1's `tenant_id … SET NOT NULL`. That was right: images from before tenancy never wrote the column, and in the one-cell Phase 1 that was a single release.
- CI's lint job checks the lint against its fixtures (`tests/migration-lint/refused`: six refusals; `accepted`: an expand-only file with every allowed shape, and a marked contract step). On a pull request it then lints every migration added relative to the base, and refuses any edit to or removal of an existing migration.
- `compat` (a CI job in `ci-ok`, and `make compat` locally):
  - `scripts/compat-override.py` writes a Compose override pinning the cell's catalog API, order service, worker, and storefront to the digests the **last** wave pins on the checkout, pulled from GHCR (`build: !reset null`). The spec said wave 1: the last wave runs the oldest images the fleet still has, so it is the stricter test.
  - The migrations, the control plane, and the edge are built from the tree. The dev seed runs, then `compat.test.ts`: a shop's whole life through the edge (signup to ACTIVE, the Merchant signs in and adds a product, a guest's Checkout to Confirmed, operator deletion to DELETED). The same file runs in the normal suite.
- ADR-0021: migrations expand, and contract only a release later, across the waves. It covers the three-release rename and the rule that manifests reach every wave at the merge.

Proven locally, not committed. A migration renaming `catalog.products.name` to `title`:
- unmarked, refused by the lint ("renames something the previous images name");
- marked `-- contract:`, it passed the lint, and `make compat` failed. First the dev seed failed (it names the column). Then, run directly, the compat test failed: the previous catalog API answered 500, `column "name" of relation "products" does not exist`, to the Merchant adding a product.
The local database was put back by hand: the column renamed back and its migration row removed.

Verified: lint, typecheck, `make compat` passing with dedicated-1's (wave 2) images from GHCR, and `make test` with the k3d cluster stopped (35 files, 197 tests passed).
