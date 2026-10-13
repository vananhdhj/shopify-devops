# 04: Fair dispatch into the settlement queue

**What to build:** The outbox dispatcher admits at most K of a tenant's Orders into the cell's queue at a time, round-robin across tenants, so a burst waits in its own tenant's outbox.

**Blocked by:** 01 (for K by plan)

**Status:** ready-for-agent

- [ ] Migration (expand-only): a new claim function bounding each tenant's dispatched-and-Pending Orders to K and interleaving tenants; the old function stays for the previous worker
- [ ] The worker uses the new function; `orders_dispatch_held_total{tenant}` counts events held back
- [ ] Seam-1 test: 50 Orders from one tenant, then one from another: the other's settles within its normal time
