# 04: Worker settles orders — stock and payment, exactly once in effect

**What to build:** After Checkout, the worker turns each Pending order into a Confirmed order or a Rejected order without ever double-deducting stock, even with retries, concurrent buyers, multiple workers, or a crash mid-processing. This introduces the outbox dispatcher, the BullMQ consumer, the catalog's internal Inventory-effect endpoint guarded by the internal service token, the three Payment scenarios, legal status transitions with appended order events, and the worker's private operational listener.

**Blocked by:** 03

**Status:** resolved

- [x] The dispatcher enqueues outbox events using the event ID as job ID; neither queue delivery nor a dispatch marker is treated as proof of execution
- [x] The internal Inventory-effect endpoint applies deductions and releases at most once per Order and action, locking product rows in a consistent order and writing stock changes with the deduplication record in one transaction; it rejects callers without the internal token
- [x] Seam-1 tests: `approve` → Confirmed order; `decline` → stock released then Rejected order (payment); `slow` → Confirmed after a delay; insufficient stock → Rejected order (out of stock) with no partial deduction
- [x] If a release cannot be applied, the Order stays Pending and retries
- [x] Only Pending → Confirmed, Pending → Rejected (out of stock), Pending → Rejected (payment), and Confirmed → Fulfilled are legal; each transition appends an order event atomically; a duplicate job for a terminal Order is a no-op
- [x] Seam-1 test: 20 concurrent Checkouts for a product with stock 1 produce exactly one Confirmed order and stock never goes negative
- [x] Seam-1 test: with two worker replicas, every Order reaches one terminal state with one deduction
- [x] Seam-1 test: killing the worker container after the stock deduction and before the status change leads, after restart, to one deduction and a terminal Order
- [x] On termination the worker stops taking jobs and leaves interrupted jobs to retry safely; readiness failure never acknowledges unfinished work
- [x] Worker exposes a private operational listener with health and metrics, including queue depth, oldest Pending order age, retries, and throughput

## Comments

- Carried from ticket 01 review: test that an in-flight request completes and new requests are refused during API shutdown (ticket 01 only proves a clean, prompt exit with no request in flight).

Resolved 2026-10-10. `make test` passes twice from a wiped stack (70 tests). Covered through the service-HTTP seam: internal Inventory-effect endpoint (token required, once-only deduct/release, no partial deduction); approve/decline/slow/out-of-stock settlements with one status-history event each; 20 concurrent Orders for the last unit (one Confirmed, Stock never negative); two worker replicas (both shown to settle jobs, one deduction per Order); SIGKILL between deduction and confirmation (one deduction after restart); a blocked release keeping the Order Pending with failures counted, then settling; worker SIGTERM finishing its active job; worker metrics; and, carried from ticket 01, an in-flight API request completing during shutdown while new requests are refused.

Decided in review: settle jobs retry 10 times and are then removed, so reconciliation (ticket 05) is the long-term retry loop; PostgreSQL enforces a statement timeout so stuck queries are cancelled server-side; readiness fails as soon as shutdown begins. The Inventory-effect contract lives in `@shop/contracts`; transactions, UUID validation, and secret comparison live in `@shop/service-kit`. Database enforcement of legal status transitions moves to ticket 06.

