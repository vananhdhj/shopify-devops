---
status: accepted
---

# Manifest policies are checked in CI, with exceptions listed by owner and expiry

Conftest checks every manifest the repository deploys on every pull request (`policy/kubernetes.rego`, `make policy`): each cell, the control plane, and the edge as rendered, the monitoring config, the Argo CD Applications, and the upstream charts this repository configures (Loki, Alloy, Sealed Secrets) as rendered with its values. A violation fails the `manifests` job and with it `ci-ok`, so the pull request cannot merge.

The rules:
- no privileged containers, no privilege escalation, no root user, no host namespaces;
- a memory limit and CPU and memory requests on every container;
- images only from the project's registry and a short list of upstream repositories, every one pinned by digest;
- no plain `Secret` in Git (ADR-0033).

Every rule has a fixture that passes and one that must fail, by that rule's name.

An exception names one rule, one container, an owner, the reason, and an expiry. An expired exception is a denial of its own, so it is renewed or removed rather than forgotten. There is one: the log agent reads root-owned files (ADR-0031).

## Considered Options

- **An admission controller** (Kyverno or Gatekeeper) that also stops a manifest applied by hand: rejected for now (Phase 7, decision 4). It costs a few hundred MiB on a cluster where only bootstrap is applied by hand. Recorded in the README as the change for a shared cluster.
- **Exceptions as Conftest's own `exception` rules**: not used. They carry no owner or expiry.

## Consequences

- Phase 7's demo pull request (#83), a privileged worker, failed with `no-privileged` in all four cells it renders and was blocked.
- The kube-prometheus-stack and Argo CD charts, installed from upstream, are not checked.
- What Argo CD applies is exactly what CI checked: the same renderings, from main.
