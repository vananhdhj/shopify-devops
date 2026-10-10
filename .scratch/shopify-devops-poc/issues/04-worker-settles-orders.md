# 04: Worker settles orders — stock and payment, exactly once in effect

**What to build:** After Checkout, the worker turns each Pending order into a Confirmed order or a Rejected order without ever double-deducting stock, even with retries, concurrent buyers, multiple workers, or a crash mid-processing. This introduces the outbox dispatcher, the BullMQ consumer, the catalog's internal Inventory-effect endpoint guarded by the internal service token, the three Payment scenarios, legal status transitions with appended order events, and the worker's private operational listener.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] The dispatcher enqueues outbox events using the event ID as job ID; neither queue delivery nor a dispatch marker is treated as proof of execution
- [ ] The internal Inventory-effect endpoint applies deductions and releases at most once per Order and action, locking product rows in a consistent order and writing stock changes with the deduplication record in one transaction; it rejects callers without the internal token
- [ ] Seam-1 tests: `approve` → Confirmed order; `decline` → stock released then Rejected order (payment); `slow` → Confirmed after a delay; insufficient stock → Rejected order (out of stock) with no partial deduction
- [ ] If a release cannot be applied, the Order stays Pending and retries
- [ ] Only Pending → Confirmed, Pending → Rejected (out of stock), Pending → Rejected (payment), and Confirmed → Fulfilled are legal; each transition appends an order event atomically; a duplicate job for a terminal Order is a no-op
- [ ] Seam-1 test: 20 concurrent Checkouts for a product with stock 1 produce exactly one Confirmed order and stock never goes negative
- [ ] Seam-1 test: with two worker replicas, every Order reaches one terminal state with one deduction
- [ ] Seam-1 test: killing the worker container after the stock deduction and before the status change leads, after restart, to one deduction and a terminal Order
- [ ] On termination the worker stops taking jobs and leaves interrupted jobs to retry safely; readiness failure never acknowledges unfinished work
- [ ] Worker exposes a private operational listener with health and metrics, including queue depth, oldest Pending order age, retries, and throughput
