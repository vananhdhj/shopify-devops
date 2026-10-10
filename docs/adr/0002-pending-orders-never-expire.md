---
status: accepted
---

# Pending orders never expire

When a dependency (Redis, the catalog API) stays down, an accepted order cannot be decided. We keep it `PENDING` indefinitely: reconciliation keeps re-enqueueing it from the outbox, the "oldest pending order above 60 seconds" alert tells a human, and the order completes normally once the dependency recovers. There is no expiry status and no merchant cancel.

## Considered Options

- **Expire after N minutes (`REJECTED_EXPIRED`)**: rejected for now. Expiry can race with a worker that has just deducted stock, so it needs idempotent stock release plus locking against in-flight processing, adding another failure path to test.
- **Merchant cancel (`CANCELLED`)**: rejected for the same race, triggered by a person instead of a timer.

## Consequences

- A buyer may watch an order stay pending for as long as an outage lasts; the operational signal is the alert, not a buyer-facing timeout.
- Adding expiry later is additive but must go through the same idempotent inventory-effect path as payment-decline compensation, never a direct stock write.
