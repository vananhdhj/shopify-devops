# 01: Manifest policies in CI with Conftest

**What to build:** Rego policies over every rendered manifest the repository deploys, checked by Conftest in CI and `make policy`; a violation fails the pull request and names its rule (decision 4: CI, not admission).

**Blocked by:** none

**Status:** ready-for-agent

- [ ] `policy/` rules: no privileged containers, root users, privilege escalation, or host namespaces; memory limits and CPU and memory requests on every container; images only from the project's registry (and the pinned upstream registries), never `:latest`; no plain `Secret` in Git except SealedSecrets (from ticket 04 on)
- [ ] CI job: every Application's rendered output (cells, platform, edge, monitoring config, Argo CD) through Conftest; fixed images and exceptions, if any, listed with an owner and an expiry
- [ ] Fixtures: for each rule, a manifest that passes and one that fails; `make policy`
- [ ] The current manifests pass (fixing what they do not)
