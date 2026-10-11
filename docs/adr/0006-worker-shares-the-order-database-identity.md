---
status: accepted
---

# The worker shares the order database identity

Database identities follow business boundaries, not deployment units: one runtime identity per schema, plus the migration identity. The worker belongs to the order boundary, so it connects as `order_app`, the same identity as the order service. Every privilege the worker needs (`UPDATE (status)` on orders, reading the outbox and setting `dispatched_at`, appending `order_events`) is on the orders schema. A separate worker identity would add a role, a secret and its wiring without adding any isolation between the two schemas, and that isolation is what the database is meant to enforce.

## Considered Options

- **A `worker_app` identity of its own**: rejected for the POC; it would mostly duplicate `order_app`'s grants, and the order service would keep its own writes to the same tables.

## Consequences

- The database cannot tell which unit changed an Order's status. The `orders_status_transition` trigger only limits which transitions are legal, and `order_events` does not record who made them.
- A compromised order service can do everything the worker can on the orders schema, and the reverse. Neither can write catalog tables, and that is tested.
- Splitting later is a small change: a new role in `db/roles.sh`, a grants migration, and a new password in `make secrets`, Compose and the worker's manifest.
