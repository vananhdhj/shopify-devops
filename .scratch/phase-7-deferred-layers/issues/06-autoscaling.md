# 06: Autoscale pool-1's storefront and catalog API

**What to build:** HorizontalPodAutoscalers for the units with no per-tenant state in memory (decision 3), and a load experiment that shows replicas rising and falling.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `autoscaling/v2` HPAs in pool-1: storefront and catalog API, 1–3 replicas, CPU 70%, scale-down stabilisation 5 minutes; requests checked by ticket 01's policy
- [ ] Argo CD ignores `spec.replicas` of autoscaled Deployments
- [ ] `make experiment-autoscale`: k6 load on pool-1's storefront through the ingress; replicas, CPU, and the VM's memory sampled; scale-out and scale-in times recorded
- [ ] The edge and order service stay at one replica (ADR-0026), stated in the ADR
