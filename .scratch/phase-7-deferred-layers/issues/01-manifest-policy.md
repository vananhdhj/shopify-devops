# 01: Manifest policies in CI with Conftest

**What to build:** Rego policies over every rendered manifest the repository deploys, checked by Conftest in CI and `make policy`; a violation fails the pull request and names its rule (decision 4: CI, not admission).

**Blocked by:** none

**Status:** in review

- [x] `policy/` rules: no privileged containers, root users, privilege escalation, or host namespaces; memory limits and CPU and memory requests on every container; images only from the project's registry (and the pinned upstream registries), never `:latest`; no plain `Secret` in Git except SealedSecrets (from ticket 04 on)
- [x] CI job: every Application's rendered output (cells, platform, edge, monitoring config, Argo CD) through Conftest; fixed images and exceptions, if any, listed with an owner and an expiry
- [x] Fixtures: for each rule, a manifest that passes and one that fails; `make policy`
- [x] The current manifests pass (fixing what they do not)

## Comments

Implementation notes (2026-10-14):
- `policy/kubernetes.rego` (Rego v1, Conftest 0.71.1). Rules, each naming itself first in its message:
  - `no-privileged`, `no-privilege-escalation` (it must be set to false, not just left out), `non-root` (`runAsNonRoot: true` on the container or its pod, and no user 0 at either level), `no-host-namespaces`;
  - `resources`: a memory limit, and CPU and memory requests;
  - `approved-registries`: `ghcr.io/vananhdhj/shopify-devops/` and the three Docker official images in use (postgres, redis, python);
  - `pinned-images`: every image by digest (stronger than the spec's "pinned tag": every image already is), never `latest`;
  - `no-plain-secrets`: no `Secret` object in Git.

  Every container and init container of every workload kind is checked: Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, Pod.
- The current manifests pass every rule as they are: nothing to fix, and no exception needed (so no exception list yet).
- `scripts/render-manifests.sh` renders every Application (each cell, the control plane and the edge for dev and staging, the monitoring config), for CI's schema check and the policies alike.
- `scripts/policy.sh` / `make policy`: Conftest over the rendered manifests and the Argo CD Applications, then the fixtures. It uses `conftest` on PATH (CI installs it, checksum-verified), or else the pinned image (`openpolicyagent/conftest@sha256:0e77cdf7…`).
- Fixtures (`policy/fixtures`): a hardened Deployment that passes, and 12 that fail, each named after the rule that must deny it (`<rule>[--<case>].yaml`). Every one was checked to be denied by its own rule and nothing else. Among them: a CronJob whose init container runs as root, a tag without a digest, and `postgres:latest`.
- Not checked: what Argo CD installs from upstream charts (kube-prometheus-stack, Argo CD itself), which the repository does not render. The admission controller that would also check those is deferred (decision 4).

`make policy`: 1,727 checks passed; the 12 failing fixtures each denied by their rule.
