---
status: accepted
---

# Probes tolerate a slow node: readiness reacts, liveness waits

Every unit's probes are set for a node that is short of CPU, not only for one that is idle. A **liveness** probe gives a check 5 seconds to answer and restarts the container only after 6 failures in a row, about a minute of failing. A **readiness** probe gives 3 seconds and keeps its default of 3 failures, so a slow pod leaves its Service within about 15 seconds and comes back on its own. A **startup** probe gives 3 seconds per check and up to 2 minutes in all. The Kubernetes defaults (1-second timeouts) stay only in third-party charts.

On 2026-10-12 the lab node's CPU was starved (the host's other work left the Colima VM about 2.4 of its 6 cores). Liveness checks timed out after 1 second, the kubelet restarted the containers, the restarts cost more CPU, and more checks timed out. Within an hour every namespace was restarting, Traefik and the router included. A probe through the ingress counted 988 failed requests out of 4,059, the last 10 minutes with nothing answering at all, although no unit was hung. A restart cannot fix a slow node. It only adds load, so here liveness was causing the outage, not detecting one.

## Considered Options

- **Keep the defaults and give the VM more CPU**: rejected as the only fix; the laptop shares its cores, and a production node can be starved just as well (noisy neighbours, throttling at a CPU limit).
- **Drop liveness probes entirely**: rejected; a deadlocked process (an event loop stuck in a loop, a hung database connection pool) would then serve nothing until someone noticed.
- **Raise the CPU requests so the scheduler protects each pod**: rejected for the lab; requests guarantee nothing once the node itself is overcommitted, and they would leave less room for the three cells of Phase 3.

## Consequences

- A truly hung container is restarted after about a minute instead of about 30 seconds.
- A slow pod drops out of its Service through readiness and rejoins without a restart, so a slow node shows as fewer ready pods and slower answers, not as a restart storm.
- Third-party components (Traefik, Argo CD, the monitoring stack) keep their charts' probes; if they keep restarting under load, their values get the same treatment.
