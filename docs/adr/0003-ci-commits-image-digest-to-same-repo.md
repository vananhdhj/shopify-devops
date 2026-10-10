---
status: accepted
---

# CI commits the image digest back to the same repository

Argo CD deploys whatever image digest is committed under `deploy/overlays/<env>/`, so after building on `main`, CI must write that digest somewhere. We commit it to this same repository using a bot deploy key that is the only bypass on `main` branch protection, and the build workflow ignores commits that touch only `deploy/` so the bump cannot retrigger itself. One repository keeps the app change and its deployment side by side in history, makes `git revert` a single-place rollback, and lets a reviewer reproduce everything from one clone.

## Considered Options

- **Separate config repository**: rejected; it avoids the protection bypass and any loop risk, but needs a cross-repo push credential and splits the story across two repositories.
- **Argo CD Image Updater**: rejected; one more in-cluster component that needs Git write credentials inside the cluster and makes the deploy step less visible in a demo.

## Consequences

- The deploy key is a privileged credential: it is the one identity allowed to push to `main` without checks.
- Path filters here apply only to the post-merge build workflow, never to checks required by branch protection, which would leave skipped checks pending.
- The exact ruleset bypass and workflow-trigger behaviour must be verified against GitHub at implementation time, not assumed.
- Verified 2026-10-10: the ruleset's bypass is the `DeployKey` actor type, which covers every deploy key on the repository, so the repository must hold exactly one write deploy key. Its push of the digest commit bypassed the pull-request and `ci-ok` rules, and the commit started no release run.

