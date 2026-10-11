---
status: accepted
---

# The Order token is an HMAC of the order id

A retried Checkout must hand back the same Order token, because a buyer whose first response timed out has no other way to read their Order. A random token stored only as a hash cannot be returned again, so we derive the token instead: `base64url(HMAC-SHA256(ORDER_TOKEN_SECRET, order id))`. Nothing token-shaped is stored; a read recomputes the HMAC and compares in constant time, and a wrong token answers exactly like an unknown Order.

## Considered Options

- **Random token stored as a hash**: rejected; a retry can't recover the token, so each retry would mint an additional valid token for the same Order, adding a token table for a weaker retry story.
- **Random token stored in plain text**: rejected; a database read would leak every buyer's access.

## Consequences

- Rotating `ORDER_TOKEN_SECRET` invalidates every Order link already handed out, so this secret is excluded from routine rotation in the POC. The upgrade path is a key-version prefix on tokens, accepting the previous key during a rotation window.
- Anyone holding the secret can mint a token for any Order; it is a server-side secret like the database passwords and never leaves the order service.
- Tokens travel in an `x-order-token` header to the API. The storefront's buyer-facing link carries the token as `?token=`, so storefront request logging must never record query strings.
- Verified 2026-10-10: the storefront's request log (`apps/storefront/proxy.ts`) records the path only, and `tests/integration/src/storefront-logs.test.ts` fails if an Order token appears in the storefront's logs.

## Amended 2026-10-11: the token binds the tenant

With many shops on the platform (ADR-0010), the token is `base64url(HMAC-SHA256(ORDER_TOKEN_SECRET, tenant id + ":" + order id))`, so a token from one shop is worthless at every other, on top of row-level security hiding the Order there. Order links issued before the change stopped working; the dev lab accepted that.
