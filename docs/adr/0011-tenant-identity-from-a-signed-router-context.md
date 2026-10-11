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
