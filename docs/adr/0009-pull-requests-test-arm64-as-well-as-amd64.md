---
status: accepted
---

# Pull requests test arm64 as well as amd64

The release publishes amd64 and arm64 images, and the lab cluster on the M2 laptop runs arm64. Our standard procedure requires an automated test of the arm64 image before it deploys, but CI ran the service-HTTP tests on amd64 only. The `integration` job now runs on both `ubuntu-latest` and `ubuntu-24.04-arm`. Compose builds the images natively on each runner, so the arm64 run builds and tests arm64 images, and `ci-ok` fails if either run fails. Merging to `main` is the gate before deployment, so testing in the pull request meets the requirement.

## Considered Options

- **Test the published arm64 digest in the release workflow, between `merge` and `deploy-dev`**: not done yet; it would test the exact image that deploys, but Compose would first need to run from published images instead of building them.

## Consequences

- The arm64 run tests the same Dockerfiles and commit as the release, but not the same build: the release rebuilds on `main`, and that build is the one that deploys.
- arm64 runners are free only for public repositories; if the repository goes private, this job starts costing money.
