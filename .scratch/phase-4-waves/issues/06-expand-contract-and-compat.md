# 06: Expand/contract migrations and the mixed-version job

**What to build:** CI keeps the previous release working on the new schema. A lint refuses destructive migration statements unless marked as a contract step, and a `compat` job runs the previous release's cell images against the new migrations, control plane, and edge.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] `scripts/migration-lint.sh` over migrations new in the PR (both databases): `DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL`, `ADD COLUMN … NOT NULL` without `DEFAULT` refused unless the file has `-- contract: <reason and the release after which it is safe>`; tested against fixtures
- [ ] `compat` job (in `ci-ok`): the PR's db-migrations, platform, and router images built; the cell service images pinned on `main` for wave 1 pulled from GHCR; a Compose override runs them together; a compatibility subset of the integration suite (signup to active, browse, checkout to Confirmed, Merchant sign-in, deletion)
- [ ] ADR: expand/contract across waves
- [ ] Proven once: a PR with a deliberately breaking migration fails the lint, and one that breaks an old image fails `compat` (recorded in the ticket, not merged)
