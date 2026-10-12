---
status: accepted
---

# One edge router for every cell, outside every cell

The router leaves the cell. One **edge router**, a Deployment of the router image in its own namespace (`edge-dev`) with its own Argo CD Application, is the only unit behind the wildcard Ingress. It loads the routing table from the control plane: each active shop with its cell, and each registered cell with its storefront URL. It maps a request's host to the shop, proxies the request to the storefront of the shop's cell, and signs the tenant context with **that cell's** secret (ADR-0011). If the shop's cell is not in the table, or the edge holds no secret for it, the edge answers its fixed "temporarily unavailable" page (503). It never falls back to another cell.

## Considered Options

- **Keep a router in every cell, with a front proxy that only picks the cell**: rejected. It means two hops and two components for one decision, and the front proxy would need the same table anyway.
- **An Ingress rule per cell or per shop**: rejected. Shops are data, not Git (ADR-0015), and a shop's cell is decided at signup. Ingress rules would make every signup a manifest change.
- **The storefront resolves the shop's cell itself**: rejected for the same reason as in ADR-0011. A unit inside a cell would decide which cell's tenants it serves.

## Consequences

- The edge holds every cell's tenant-context secret, so it is the platform's most trusted unit. A cell still holds only its own secret, so a leaked cell secret exposes that cell's shops alone.
- A cell can be down without the edge noticing anything beyond its own 503s for that cell's shops. The other cells' shops are served as before (measured in the Phase 3 cell-outage drill).
- The edge is now a single point of failure for every shop. It runs one replica in the lab, so a rollout of the edge costs seconds of errors for every cell. A second replica and a preStop delay are follow-up work for Phase 4's release waves.
- The switch from the cell's router to the edge was a release of its own. Both Ingresses served during it, and Argo CD pruned the old one last. A probe through the ingress recorded no failed request across the switch.
- The cell no longer contains a router. Adding a cell needs no new Ingress, only a directory, its secrets, and its registration (ADR-0019).
