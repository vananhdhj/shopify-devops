# 04: Cluster secrets as SealedSecrets in Git

**What to build:** The Sealed Secrets controller; `make secrets` seals each namespace's Secret for commit; the cluster's secrets come from Git, and `scripts/cluster-secrets.sh` retires once they do.

**Blocked by:** none

**Status:** in progress (the controller first; the sealed copies once it runs)

- [x] The controller (pinned chart, its own Argo CD Application or bootstrap), memory-limited
- [ ] `make secrets` writes `deploy/**/sealed-*.yaml` with `kubeseal` against the controller's certificate, for every Secret `cluster-secrets.sh` writes today (cells, platform, edge, `cell-credentials`, the promoter's token)
- [ ] The switch: sealed copies deployed and equal to today's Secrets first, then `cluster-secrets.sh` stops writing them (dependencies first)
- [x] The controller's key exported to `.secrets/` (never Git), and a documented restore, rehearsed once on the lab cluster
- [ ] Policy (ticket 01): no plain `Secret` in Git

## Comments

Implementation notes, first PR (2026-10-15): the controller, on its own, because a SealedSecret in any Application cannot sync until the CRD exists (dependencies first).
- `deploy/argocd/sealed-secrets.yaml`: an Application of the `sealed-secrets` chart 2.20.0 (controller 0.40.0) from `https://bitnami.github.io/sealed-secrets` (the project's old `bitnami-labs.github.io` repository answers 404), in `kube-system`, named `sealed-secrets-controller` (kubeseal's default). `deploy/sealed-secrets/values.yaml`: the image pinned by digest, 32 Mi requested, 96 Mi limit.
- `make argocd-apps` (and so `bootstrap-gitops`) applies it first. After the merge, `make argocd-apps` installs it.
- The manifest policies render the chart too (`render-manifests.sh`, version from the Application); its image's repository is approved. The chart already meets every security rule. 2,057 checks.
- Next PR: the controller's public certificate in the repository (sealing works offline with it), `make secrets` sealing each namespace's Secrets, the switch from `cluster-secrets.sh`, and the key backup and restore.
