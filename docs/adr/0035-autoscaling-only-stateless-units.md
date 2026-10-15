---
status: accepted
---

# Only units with no per-tenant state in memory autoscale, on CPU per pod above their idle cost

pool-1's storefront and catalog API have HorizontalPodAutoscalers (Phase 7, decision 3):
- 1 to 3 replicas;
- scale out when the pods average more than 150m (storefront) or 80m (catalog API) of CPU, several times an idle pod's cost;
- up by at most one pod a minute after a minute's load, and down only after 5 quiet minutes.

The two Deployments leave `replicas` unset in that cell, so Argo CD and the autoscaler never fight over it.

The edge and the order service stay at one replica. Their per-shop limits live in each process's memory (ADR-0026), so N replicas would allow N times the limit. The worker and the dedicated and canary cells are not autoscaled either.

## Considered Options

- **Shared limits in Redis, so every unit can scale**: rejected again (Phase 5, decision 3), a new dependency on every request.
- **A target relative to the CPU requested** (70% of 50m): the first version. Rejected after it scaled both units to 3 on startup bursts with no load and could never scale back in, since a pod's idle cost does not shrink with more pods.

## Consequences

- Under load (Phase 7 evidence) the storefront went from 1 to 3 replicas in two minutes and back to 1 five and a half minutes after the load. Until the second pod was ready, the first answered slowly (p95 3.6 s).
- The edge stays a single replica and a single point of failure (the Phase 4 follow-up of a second edge stands).
- Every container has CPU and memory requests (ADR-0032), which the autoscaler needs.
