---
status: accepted
---

# Merchant sessions bind a credential version the router states

Merchant passwords live only in the control plane's registry. A cell's storefront checks a sign-in by asking the control plane (`POST /internal/merchant-sign-ins`), which answers yes or no; the hash never reaches the cell. The session cookie the storefront issues is signed over the tenant id, its expiry, and the shop's **credential version**, a counter the registry bumps whenever the Merchant credential changes. The router carries that version in the signed tenant context (ADR-0011), so checking a session on every admin request needs neither the control plane nor the credential.

## Considered Options

- **Sign sessions over the password hash** (Phase 1): rejected; the cell would have to hold every shop's hash.
- **Ask the control plane on every admin request**: rejected; a control-plane outage would sign every Merchant out, and every admin page would add a cross-plane round trip.
- **A server-side session store**: not yet; it would allow revoking one stolen cookie, which neither design here can, but it is another stateful dependency for the lab.

## Consequences

- Bumping a shop's credential version signs all its sessions out within one routing refresh (about 2 seconds). Signing out still clears only one browser's cookie.
- A sign-in during the refresh window after a change is answered "try again" rather than issuing a session that would be signed out at once.
- With the control plane down, new Merchant sign-ins fail with a clear message; existing sessions keep working.
