---
status: accepted
---

# A request's tenant comes only from a context the router signs

The router, the cell's only unit on the ingress, maps the request's host (`<handle>.shop.localhost`) to a tenant and attaches a tenant context: the tenant's id, handle, and name, with an issue time, signed with the cell's `TENANT_CONTEXT_SECRET` (HMAC-SHA256) and valid for 60 seconds. It drops any context the client sent. The storefront and both APIs refuse requests without a valid context; the storefront passes it on to every API call, and the order service passes it on to the catalog. No unit believes a tenant named any other way: not a path, a query parameter, a body field from a browser, a cookie, or the admin service token.

## Considered Options

- **The storefront reads the host itself**: rejected; every unit behind it would have to trust whatever tenant the storefront forwarded, and a storefront reached around the edge would serve any shop it was told to.
- **An unsigned tenant header, trusted inside the cluster**: rejected; one misrouted or directly exposed port would let a client choose its shop. The signature makes a context something only the edge can produce.
- **A per-request token from a control plane**: not yet; there is no control plane until Phase 2. The router's static tenant table (`deploy/base/tenants.json`) stands in for it.

## Consequences

- One secret per cell: a leak exposes that cell's tenants, not the platform. Rotating it is a `make secrets` edit and a restart of the router, storefront, and both APIs.
- A captured context can be replayed for at most 60 seconds, and only inside the cell, where only the router's traffic arrives.
- The worker settles Orders, not shop requests, so it has no context to pass on. The catalog's internal Inventory-effect endpoint takes the tenant from its body instead, trusted because only the worker holds the internal token.
- Probe and scrape routes, and that internal route, are the only ones outside any tenant; service-kit refuses every other route without a context, so a new route cannot forget the check.
- Unknown shop addresses get one fixed 404 from the router and never reach the storefront.

## Amended 2026-10-11: the router reads the control plane

The static tenant table is retired (Phase 2). The router loads its routing table from the control plane's internal listener at start and every 2 seconds, keeping the last good copy when the control plane is down (ADR-0013), and serves only active shops; a shop being set up or suspended gets a fixed page, and a deleted one answers like an unknown address. The tenant context now also carries the shop's credential version (ADR-0014). The bare base domain is forwarded, without any tenant context, to the control plane's public signup pages.

## Amended 2026-10-12: the edge signs for every cell

The router is no longer a unit of the cell (Phase 3, ADR-0018). One edge router serves every cell. It signs each request's context with the secret of the shop's cell, so a cell's units still accept only contexts signed with their own secret. A shop whose cell is unknown to the edge, or whose secret the edge lacks, gets a 503, never another cell's page.
