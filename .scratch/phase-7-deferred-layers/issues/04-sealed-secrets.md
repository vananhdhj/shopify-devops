# 04: Cluster secrets as SealedSecrets in Git

**What to build:** The Sealed Secrets controller; `make secrets` seals each namespace's Secret for commit; the cluster's secrets come from Git, and `scripts/cluster-secrets.sh` retires once they do.

**Blocked by:** none

**Status:** in review (the restore is rehearsed once the switch is deployed)

- [x] The controller (pinned chart, its own Argo CD Application or bootstrap), memory-limited
- [x] `make secrets` writes `deploy/**/sealed-*.yaml` with `kubeseal` against the controller's certificate, for every Secret `cluster-secrets.sh` writes today (cells, platform, edge, `cell-credentials`, the promoter's token)
- [x] The switch: sealed copies deployed and equal to today's Secrets first, then `cluster-secrets.sh` stops writing them (dependencies first)
- [x] The controller's key exported to `.secrets/` (never Git), and a documented restore, rehearsed once on the lab cluster
- [x] Policy (ticket 01): no plain `Secret` in Git

## Comments

Implementation notes, first PR (2026-10-15): the controller, on its own, because a SealedSecret in any Application cannot sync until the CRD exists (dependencies first).
- `deploy/argocd/sealed-secrets.yaml`: an Application of the `sealed-secrets` chart 2.20.0 (controller 0.40.0) from `https://bitnami.github.io/sealed-secrets` (the project's old `bitnami-labs.github.io` repository answers 404), in `kube-system`, named `sealed-secrets-controller` (kubeseal's default). `deploy/sealed-secrets/values.yaml`: the image pinned by digest, 32 Mi requested, 96 Mi limit.
- `make argocd-apps` (and so `bootstrap-gitops`) applies it first. After the merge, `make argocd-apps` installs it.
- The manifest policies render the chart too (`render-manifests.sh`, version from the Application); its image's repository is approved. The chart already meets every security rule. 2,057 checks.
- Next PR: the controller's public certificate in the repository (sealing works offline with it), `make secrets` sealing each namespace's Secrets, the switch from `cluster-secrets.sh`, and the key backup and restore.

The controller from #71 runs in `kube-system` (installed with `make argocd-apps`). Its first start spent 57 s generating its RSA key on a busy node and was restarted cleanly, once.

Implementation notes, second PR (2026-10-15):
- `deploy/sealed-secrets/cert.pem`: the controller's public certificate (valid until 2036), committed. Sealing needs no cluster.
- `scripts/seal-secrets.py` (run by `make secrets`) builds the nine Secrets `cluster-secrets.sh` used to apply, from `.secrets/` exactly as before:
  - each cell's `shop-secrets`;
  - `platform-secrets` and `cell-credentials` in `platform-dev`;
  - `edge-secrets` and `cell-credentials` in `edge-dev`;
  - `grafana-admin` and `alertmanager-discord` in `monitoring`.

  It seals each with kubeseal 0.40.0 (the pinned image) against that certificate, beside its Application's manifests (`sealed-*.yaml`, in each kustomization's resources).
  - Sealing is randomised, so each file records an HMAC of its plaintext, keyed by `.secrets/seal-hmac-key`. An unchanged Secret keeps its file: a second run changed nothing.
  - `--verify` compares the cluster's Secrets with the local values by sha256 (no value printed): all nine equal, key for key, before the switch.
- **The switch** (dependencies first). The controller refuses to overwrite a Secret it does not manage, so `cluster-secrets.sh` now:
  - creates the namespaces;
  - restores the sealing key from `.secrets/` into a cluster that has none (before the controller starts, on a rebuild);
  - marks the existing Secrets `sealedsecrets.bitnami.com/managed: "true"`.

  It writes no Secret any more. The existing Secrets were marked before merge.
- **One SealedSecret applied ahead of the merge**, to prove decryption end to end: `edge-dev/edge-secrets`. The controller reported `Synced=True`, the value's hash was unchanged, and the Secret is now owned by its SealedSecret. At the merge, Argo CD takes the object over.
- `make seal-key-backup` / `make seal-key-restore` (`scripts/seal-key.sh`): the controller's key to `.secrets/sealed-secrets-key.yaml` (mode 600) and back, restarting the controller. Backed up once (1 key).
- The policy's `no-plain-secrets` holds (SealedSecrets are their own kind). kubeconform validates SealedSecrets against the CRD catalog: 195 resources valid. `make policy`: 2,352 checks.
- README: the security model and the deploy notes describe sealed Secrets and the key backup.
- Gitleaks flagged the ciphertext (46 × `generic-api-key`). `.gitleaks.toml` keeps the default rules and allows one shape only: both a `sealed-*.yaml` file under `deploy/` and a line that is one key's kubeseal ciphertext (`Ag…`, 300+ base64 characters; 4096-bit RSA gives 680+). A live-looking API key planted in a sealed file was still caught.
