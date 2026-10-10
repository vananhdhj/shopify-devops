# 07: CI pipeline — a commit becomes a tested image in GHCR

**What to build:** Every pull request is linted, tested through the service HTTP seam against real PostgreSQL and Redis, and scanned for secrets, without any deployment credentials. Only affected services are tested and built, but shared-contract or lockfile changes trigger every consumer. On main, each affected image is built once, pushed to GHCR, and identified by digest. Requires the author to create the public GitHub repository and sign in with `gh` first.

**Blocked by:** 01

**Status:** resolved

- [x] The local repository is pushed to a public GitHub repository and branch protection on main requires one aggregate check
- [x] The pull-request workflow runs lint, seam-1 tests, and Gitleaks, with no deployment credentials available
- [x] Affected-service detection runs at job level; a change to one service runs only its jobs; a change to a shared package or lockfile runs all consumers
- [x] The aggregate check always runs, fails on any failed or cancelled required job, and accepts intentionally skipped ones
- [x] A failing test blocks merging
- [x] On main, each affected image is built once, pushed to GHCR, and its digest recorded as a workflow output or artifact
- [x] GHCR package visibility is verified so the cluster can pull without credentials; any one-time manual step is documented

## Comments

- Carried from ticket 01 review: Gitleaks in CI also covers commits made before `make hooks` ran (e.g. from a fresh clone), which the local pre-commit hook cannot guard.

Resolved 2026-10-10. Evidence on github.com/vananhdhj/shopify-devops:
- Repository public; `main` ruleset requires a pull request and the `ci-ok` check (pinned to the GitHub Actions app), blocks force-push and deletion, no bypass actors. A direct push to `main` was rejected with GH013.
- PR #1: every job green, including the integration suite on the runner; CI also caught a real race in two tests (reading an Order just after Checkout), fixed in the same PR.
- PR #2 (drill): a deliberately failing test failed `integration` and `ci-ok`, service jobs were skipped (tests-only change), and the merge state was BLOCKED; closed unmerged.
- Affected detection: tests-only changes skip service jobs; shared changes (packages, lockfile, build and CI config) run every service.
- Release on `main`: each affected service is built natively for amd64 and arm64, pushed by digest, merged into one multi-arch image tagged `sha-<commit>`, and its index digest recorded as an artifact. Added in PR #3 after a pull by digest on the arm64 laptop failed with the original amd64-only images.
- GHCR: images inherit the public repository's visibility through their source label; pulled by digest on the laptop with no credentials, all linux/arm64, and a container started natively. No manual visibility step needed.

Decisions: Biome for lint (warnings fail CI; non-null assertions allowed because tsconfig enables noUncheckedIndexedAccess); actions pinned to commit SHAs; gitleaks binary checksum-verified rather than a third-party action; commit author is the GitHub noreply address (unpublished history was rewritten before the first push).

