# 06: Fleet view

**What to build:** One command that answers "what runs where": every cell's role, capacity, shop counts, API readiness, Argo CD sync and health, and image digests.

**Blocked by:** 01 (API), 05 (cluster columns)

**Status:** ready-for-agent

- [ ] `GET /operator/cells`: directory, shop counts by status, live readiness of each cell's catalog and order APIs (short timeout, never fails as a whole)
- [ ] `make fleet`: that view plus, from the cluster, each cell Application's sync and health and its image digests (short form), and the edge's
- [ ] Seam-1 test: the view counts shops per cell and marks a stopped cell's APIs not ready
