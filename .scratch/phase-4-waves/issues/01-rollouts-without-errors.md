# 01: Rollouts without failed requests

**What to build:** A rollout of any cell unit, the edge, or the control plane loses no buyer request, so a gate that reads error ratios measures the release and not its own rollout. Every Deployment rolls with a new pod ready before the old one stops, and a stopping pod keeps serving until Traefik has dropped its endpoint.

**Blocked by:** none

**Status:** in review

- [ ] Every Deployment in `deploy/base`, `deploy/platform/base`, and `deploy/edge/base`: `strategy.rollingUpdate.maxUnavailable: 0`, `maxSurge: 1`
- [ ] A `preStop` delay (a sleep longer than endpoint propagation, e.g. 5 s) and a `terminationGracePeriodSeconds` that covers the delay plus service-kit's drain; the storefront too
- [ ] Manifests work with the previous image (no image change needed)
- [ ] Cluster: `scripts/watch-availability.sh` through the ingress for every cell's shop during a rollout of all three cells, the edge, and the control plane (`kubectl rollout restart`, one cell at a time) records no failed request; timings in the ticket

## Comments

Implementation notes (2026-10-13):
- With one replica the default rolling update already surges (25% rounds up to 1 extra pod, down to 0 unavailable), so the rollout errors of Phase 3 came from the stopping pod: Traefik and the Services kept sending it requests for a moment after it began terminating, and service-kit's drain refuses new requests at once. Every Deployment now states `maxUnavailable: 0, maxSurge: 1`, so the intent survives a change of replicas.
- The five units behind a Service (catalog API, order service, storefront, control plane API, edge) get `preStop: sleep 5 s`, Kubernetes' native sleep action (no shell in the hook, nothing needed in the image): the pod keeps serving while its endpoint is removed, then SIGTERM starts the drain. The default 30 s grace covers 5 s plus service-kit's 8 s drain bound. The two workers have no Service and keep their shutdown as is.
- No image change; the manifests work with the running images.

Rendered cells, control plane, and edge: kubeconform 106 valid, 0 invalid (CRDs skipped locally); server dry-run accepted on the cluster. The zero-failure rollout check runs on the cluster after the merge.
