---
status: accepted
---

# One settlement queue per cell, filled fairly by the dispatcher

A cell keeps its one BullMQ queue for settling Orders. Fairness between shops is decided before a job enters it:
- The outbox dispatcher claims events through `orders.claim_fair_events(batch, per_tenant)`. A shop's waiting events are admitted only while its Orders already dispatched and still Pending number at most `per_tenant` (10).
- Shops are taken round-robin: every shop's oldest waiting event first, then every shop's second.
- A burst waits in its own shop's outbox, which is durable already. Every other shop's Orders go straight into the queue.

## Considered Options

- **A rate limit per tenant in the worker** (a token bucket checked when a job runs): rejected. The burst still sits at the head of the shared queue, and every other shop's job waits behind it while the worker delays the burst's jobs one by one.
- **One queue per tenant, and a worker rotating across them**: rejected. Queues would come and go with signups, and the worker would need its own scheduling across them. It is a lot of moving parts for what one SQL ordering does.
- **BullMQ Pro's groups**: rejected for a paid license on a lab.

## Consequences

- In Compose, a burst of 50 Orders with 3 s payments (about 30 s of first-in-first-out work at 5 jobs at a time) did not hold back another shop's single Order: it was Confirmed in under 15 s while more than 20 of the burst were still Pending.
- One `per_tenant` for every shop is exact only because placement never mixes plans in a cell (ADR-0020); the worker has no tenant context to read a plan from. A cell holding both plans would need the limit per shop in the claim.
- The claim joins the outbox to the Orders on every dispatch tick. That is cheap at the lab's 20 shops per pooled cell, but would want an index on Pending Orders by tenant at scale.
- Reconciliation still clears a stale dispatch mark; such an Order is admitted again under the same job id, which BullMQ ignores while the job exists.
