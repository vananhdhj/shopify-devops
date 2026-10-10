# 05: Reconciliation — no accepted Order is lost when the queue fails

**What to build:** Orders accepted while Redis is down, or whose queue entry is lost after dispatch, are still settled once the system recovers. Reconciliation periodically re-enqueues stale Pending orders from the outbox, and never creates Inventory effects with new keys. Pending orders never expire (ADR-0002). Redis is configured for persistence with a non-evicting memory policy and serves only as the queue.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Outbox events are retained until their Order is terminal
- [ ] Reconciliation re-enqueues Pending orders older than a threshold, reusing their stable event IDs
- [ ] Seam-1 test: with Redis stopped, Checkout still returns Pending orders; after Redis restarts, every one of them reaches a terminal state
- [ ] Seam-1 test: deleting a dispatched job from the queue still ends with a terminal Order and exactly one deduction
- [ ] Redis runs with persistence and a non-evicting memory policy in both Compose and the cluster configuration
- [ ] There is no expiry status and no cancel action

## Comments

- Carried from ticket 04 review: reconciliation is the long-term retry loop. Settle jobs make 10 quick attempts and are removed as soon as they fail for good (`removeOnFail: true`), so their stable event id is free to be re-enqueued. Test that an Order whose job exhausted its attempts is eventually settled by reconciliation.
