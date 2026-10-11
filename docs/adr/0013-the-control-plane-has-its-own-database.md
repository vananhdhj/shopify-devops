---
status: accepted
---

# The control plane keeps the registry in its own database

The tenant registry (every shop, its status, its cell, its Merchant credential, and its lifecycle audit) lives in a PostgreSQL database of its own, `platform`, run by the control plane in its own namespace and its own Argo CD Application, with its own identities (`platform_migrator`, `platform_app`). No cell holds it and no cell's failure can take it down; equally, the registry depends on no cell, so it can place, move, and delete shops across cells later (Phase 3).

## Considered Options

- **A `platform` schema in the cell's database**: rejected; a cell outage would stop signups and operator actions for every cell, and the control plane would be tied to one cell before there are several.
- **The static tenant file, kept in Git**: retired; a shop that needs a commit and a deployment to exist cannot sign up in seconds, and Git would hold customer data (ADR-0015).

## Consequences

- The routers keep a cached copy of the routing table (refreshed every 2 seconds), so a control-plane outage stops only changes: signups, sign-ins of Merchants, and operator actions. Buyers of existing shops and existing Merchant sessions keep working. A router that starts while the control plane is down stays unready until it gets a first table.
- Two databases to back up and restore; the per-tenant restore of Phase 6 has to cover both.
- The cell reaches the control plane only through its internal listener, with a token per caller (router, storefront); the control plane reaches the cell only through its router and its purge endpoints, with the cell token.
