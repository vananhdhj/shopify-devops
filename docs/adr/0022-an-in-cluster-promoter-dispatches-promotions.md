---
status: accepted
---

# An in-cluster promoter moves releases through the waves by dispatching a workflow

A release reaches the cells in waves: wave 0 is the canary, together with the control plane and the edge; wave 1 is the pooled cells; wave 2 is the dedicated cells. The release workflow pins new digests in wave 0 only.

A **promoter**, a loop in the platform image running in the control plane's namespace, does the rest:
- it finds a wave running a release that the next wave lacks;
- it soaks that release behind a gate (ADR-0024);
- when the gate passes, it asks GitHub to run the `promote` workflow.

The workflow checks that the previous wave pins exactly the gated digests, writes them into the next wave's cell directories, and commits with the deploy key. Every wave's version is therefore a commit, and rolling back is a revert.

## Considered Options

- **Argo CD progressive syncs (RollingSync)**: rejected. They are Beta in the pinned v3.5.4, advance on Application health alone (no soak, no metrics gate), turn off automated sync on every generated Application, and record nothing in Git. Every cell tracks the same `main` revision, so which wave runs what would live only in the cluster.
- **The promotion job in GitHub Actions**: rejected. A GitHub-hosted runner cannot reach the lab's Prometheus or its edge, so it could not run the gate.
- **A promoter that pushes the commit itself, with a deploy key of its own**: rejected. The repository's ruleset bypass covers every deploy key (ADR-0003), so a second key would be a second identity able to skip branch protection, and it would live in the cluster. ADR-0003 rejected Argo CD Image Updater for the same reason.

## Consequences

- The promoter holds only a fine-grained token with *Actions: write* on this repository. A stolen token can start workflows, but cannot push code, and `promote` refuses any digest the previous wave does not run.
- The first wave release stalled 14 minutes on that token's permission: it had *Actions: read*, and GitHub answered 403. The gate had passed, the promoter retried every tick, and the release stayed in the canary. Nothing broke; a check of the token's permission belongs in the setup.
- The operator can run the same step by hand (`gh workflow run promote.yml -f wave=1`) when the promoter is down; it takes the previous wave's own pins.
- Only image digests move by wave. Manifests reach every cell at the merge, so they must work with the previous release's images (ADR-0021).
- The promoter's state is in the registry (`platform.promotions`): a restart resumes a soak, and nothing is dispatched twice. With one replica and `Recreate`, two promoters never overlap.
