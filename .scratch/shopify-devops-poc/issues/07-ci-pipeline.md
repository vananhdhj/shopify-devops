# 07: CI pipeline — a commit becomes a tested image in GHCR

**What to build:** Every pull request is linted, tested through the service HTTP seam against real PostgreSQL and Redis, and scanned for secrets, without any deployment credentials. Only affected services are tested and built, but shared-contract or lockfile changes trigger every consumer. On main, each affected image is built once, pushed to GHCR, and identified by digest. Requires the author to create the public GitHub repository and sign in with `gh` first.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The local repository is pushed to a public GitHub repository and branch protection on main requires one aggregate check
- [ ] The pull-request workflow runs lint, seam-1 tests, and Gitleaks, with no deployment credentials available
- [ ] Affected-service detection runs at job level; a change to one service runs only its jobs; a change to a shared package or lockfile runs all consumers
- [ ] The aggregate check always runs, fails on any failed or cancelled required job, and accepts intentionally skipped ones
- [ ] A failing test blocks merging
- [ ] On main, each affected image is built once, pushed to GHCR, and its digest recorded as a workflow output or artifact
- [ ] GHCR package visibility is verified so the cluster can pull without credentials; any one-time manual step is documented
