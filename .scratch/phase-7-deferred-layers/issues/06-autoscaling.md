# 06: Autoscale pool-1's storefront and catalog API

**What to build:** HorizontalPodAutoscalers for the units with no per-tenant state in memory (decision 3), and a load experiment that shows replicas rising and falling.

**Blocked by:** 01

**Status:** in review (the experiment after the merge)

- [x] `autoscaling/v2` HPAs in pool-1: storefront and catalog API, 1–3 replicas, CPU 70%, scale-down stabilisation 5 minutes; requests checked by ticket 01's policy
- [x] Argo CD ignores `spec.replicas` of autoscaled Deployments
- [ ] `make experiment-autoscale`: k6 load on pool-1's storefront through the ingress; replicas, CPU, and the VM's memory sampled; scale-out and scale-in times recorded
- [x] The edge and order service stay at one replica (ADR-0026), stated in the ADR

## Comments

Implementation notes (2026-10-15):
- `deploy/cells/dev/pool-1/autoscaling.yaml`: `autoscaling/v2` HPAs for pool-1's storefront and catalog API: 1 to 3 replicas at 70% of the CPU requested (50m each), scale-down stabilisation 300 s, on k3s's metrics-server (healthy again since the Alloy fix).
- Instead of Argo CD ignoring `spec.replicas`, pool-1's kustomization removes `replicas` from those two Deployments, so the field is no Application's to set.
  - The cells sync with client-side apply: the field is dropped once (it stays 1), and from then on only the autoscaler sets it.
  - The other cells, and pool-1's order service and worker, keep `replicas: 1`.
- The edge and the order service stay at one replica (decision 3; ADR-0026: their per-shop limits are per process). The worker is not scaled either (its fair dispatch is per tenant in the database, but its concurrency per replica would multiply).
- `make experiment-autoscale` (`scripts/experiment-autoscale.sh`, `tests/load/autoscale.js`, k6 1.3.0):
  - asks for four of pool-1's starter shops' home pages at 8 a second each (under their plan's 10) for 4 minutes, through the ingress;
  - samples every 10 s the two units' ready replicas and CPU, and the VM's load and available memory, until both are back at one replica;
  - prints when each scaled out and back in, and the answers by status.
- A server-side dry-run of pool-1 against the lab cluster passes (the two HPAs created, the two Deployments changed). `make policy` passes.

Found after the merge (2026-10-14, fixed in a follow-up PR):
- **The first targets scaled out with no load and could not scale back in.** The HPAs targeted 70% of the 50m CPU each pod requests. An idle storefront pod uses about 29m and an idle catalog API pod about 17m (synthetic Checkouts, probes, scrapes), so startup bursts after #76's rollout took both to 3 replicas within ten minutes.
  - They stayed there: with 3 pods the storefront averaged 58% of its request, and going to 2 needs under 47%, but each pod's idle cost does not shrink with more pods.
  - The four extra pods, with Argo CD and Colima's guest agent busy on the churn, put the VM's load back at 34 and slowed every request during the rotation drill's first step.
- **The fix**:
  - targets as an average CPU per pod, several times an idle pod's: storefront 150m, catalog API 80m;
  - a scale-up behaviour: a 60 s stabilisation, then at most one pod a minute, so a startup burst cannot snowball.

