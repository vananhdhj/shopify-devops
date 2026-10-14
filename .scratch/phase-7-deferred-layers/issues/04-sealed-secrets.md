# 04: Cluster secrets as SealedSecrets in Git

**What to build:** The Sealed Secrets controller; `make secrets` seals each namespace's Secret for commit; the cluster's secrets come from Git, and `scripts/cluster-secrets.sh` retires once they do.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] The controller (pinned chart, its own Argo CD Application or bootstrap), memory-limited
- [ ] `make secrets` writes `deploy/**/sealed-*.yaml` with `kubeseal` against the controller's certificate, for every Secret `cluster-secrets.sh` writes today (cells, platform, edge, `cell-credentials`, the promoter's token)
- [ ] The switch: sealed copies deployed and equal to today's Secrets first, then `cluster-secrets.sh` stops writing them (dependencies first)
- [ ] The controller's key exported to `.secrets/` (never Git), and a documented restore, rehearsed once on the lab cluster
- [ ] Policy (ticket 01): no plain `Secret` in Git
