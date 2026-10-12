# 01: Rollouts without failed requests

**What to build:** A rollout of any cell unit, the edge, or the control plane loses no buyer request, so a gate that reads error ratios measures the release and not its own rollout. Every Deployment rolls with a new pod ready before the old one stops, and a stopping pod keeps serving until Traefik has dropped its endpoint.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] Every Deployment in `deploy/base`, `deploy/platform/base`, and `deploy/edge/base`: `strategy.rollingUpdate.maxUnavailable: 0`, `maxSurge: 1`
- [ ] A `preStop` delay (a sleep longer than endpoint propagation, e.g. 5 s) and a `terminationGracePeriodSeconds` that covers the delay plus service-kit's drain; the storefront too
- [ ] Manifests work with the previous image (no image change needed)
- [ ] Cluster: `scripts/watch-availability.sh` through the ingress for every cell's shop during a rollout of all three cells, the edge, and the control plane (`kubectl rollout restart`, one cell at a time) records no failed request; timings in the ticket
