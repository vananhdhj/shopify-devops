# 03a: Probes tolerate a slow node

**What to build:** Probe settings that let a CPU-starved node slow down without a restart storm, merged before the ingress switch (03) so the switch's outage window can be measured on a steady node. Found while preparing 03: an hour of probing through the ingress before any merge counted 988 failed requests out of 4,059, with the last 10 minutes fully down, all from liveness restarts under CPU starvation (ADR-0017).

**Blocked by:** none

**Status:** in review

- [x] Liveness: 5 s timeout, 6 failures (about a minute) before a restart
- [x] Readiness: 3 s timeout, default 3 failures
- [x] Startup: 3 s timeout, up to 2 minutes
- [x] Every unit we deploy: the cell's five units, PostgreSQL and Redis, the control plane's API, worker, and database, and the edge
- [x] ADR-0017
- [ ] Cluster: no restarts from probe failures over 30 minutes of probing through the ingress, with the host's other load eased

## Comments

Diagnosis (2026-10-12, 05:09–06:09 UTC): inside the node CPU was 99% busy, tasks waited for a CPU 50–68% of the time, and memory had 6 GB free, so there was no memory pressure. The host's 8 cores were shared with other work (about 2 cores of browser), which left the Colima VM about 2.4 of its 6. The events show "failed liveness probe, will be restarted" for the edge, Traefik, the cell's router and worker, Argo CD, and the monitoring operator, with kube-state-metrics at 31 restarts.
