# Phase 6 on the lab cluster: tenant export, freeze, move, and restore (tickets 01–05)

Recorded 2026-10-13/14 (times UTC) on the author's workstation: Apple M2, 16 GB RAM; Colima VM with 6 CPUs and 8 GB; k3d 5.9.0 running one k3s v1.35.5 server; Argo CD v3.5.4. Cells: `canary` (wave 0), `pool-1` (wave 1, at most 20 shops), `dedicated-1` (wave 2, one plus shop).

## Exit gate: the move experiment

`make experiment-tenant-move`, 2026-10-14 from 12:48, with the VM's load at 3.7 and half the host's memory free:
1. dedicated-1 was freed: `plus-a2d37b`, the plus test shop from Phase 3, was deleted.
2. A fresh starter shop, `mv-exp-5ee0b6`, was signed up in pool-1. It got 3 products, an approved and a declined Order, and Carts left open, all through the ingress as its Merchant and buyers.
3. Probes through the ingress, by the shop's address, ran throughout: the home page 4 times a second, and a Cart add once a second.
4. 3 Orders with the slow payment (3 s) were placed, so 3 of the shop's 5 Orders were Pending when the move was asked for (`make tenant-move`).

| Step (event) | At | Frozen so far |
|---|---|---|
| `move` (`ACTIVE → MOVING`) | 12:49:02.368 | 0 |
| `move_drained`: the grace out, no Order Pending | 12:49:07.534 | 5,147 ms |
| `move_verified`: exported, imported, every table checked | 12:49:07.632 | |
| `move_switched` (`MOVING → ACTIVE`, in dedicated-1, plus) | 12:49:07.638 | **5,271 ms** |
| `move_source_purged`: nothing of the shop left in pool-1 | 12:49:12.709 | |

| Table | Rows (source = target) | md5 |
|---|---|---|
| catalog.products | 3 | 15da332f… |
| catalog.carts | 8 | 696284bd… |
| catalog.cart_items | 8 | 3308d5c8… |
| catalog.inventory_effects | 6 | 5de8e7ae… |
| orders.orders | 5 | 365df2f6… |
| orders.order_items | 5 | e4a9804f… |
| orders.order_events | 5 | 062cab22… |
| orders.outbox | 5 | 9c89f080… |

**The bound is met:**
- the freeze was 5.3 s, under 30 s;
- every table's count and checksum was equal in both cells;
- the same 5 Order ids were there before (in pool-1) and after (in dedicated-1), with none Pending after: the 3 Pending ones settled in pool-1 during the 5 s grace, before the copy (ADR-0028);
- no row of the shop was left in pool-1;
- the probe's 60 home-page requests were all answered 200, and the home page answered 200 from dedicated-1 after.

As a buyer saw it, Cart adds were refused (503, "This shop is updating") 4 times over 3.4 s. The rest of the 5.3 s falls before the edge's next routing refresh (up to 2 s) and between the once-a-second probes. The shop is plus in dedicated-1 now, and stays there as the cell's shop.

## Exit gate: the restore experiment

`make experiment-tenant-restore`, from 12:49:38:
1. A fresh starter shop, `rs-exp-3d432a` in pool-1, with 4 products and an Order.
2. An on-demand export `2e62dd59…` at 12:49:43.074: 4 products, 1 Cart, 1 Order, 3 KB.
3. After the export, a buyer placed an Order (`d7a7a57d…`), and the Merchant deleted 2 products in the admin, leaving "Restore Bowl, Restore Plate".
4. `make tenant-restore` to the export:

| Step (event) | At | Frozen so far |
|---|---|---|
| `restore` (`ACTIVE → RESTORING`, "everything the shop changed since 12:49:43.074Z is lost") | 12:49:47.162 | 0 |
| `restore_drained` | 12:49:52.181 | 5,010 ms |
| `restore_saved`: the shop as it was, as pre-restore export `98718cc9…` | 12:49:52.203 | |
| `restored` (`RESTORING → ACTIVE`): purged, imported, every table checked | 12:49:52.266 | **5,095 ms** |

**The bound is met:**
- the shop lists all 4 products again;
- its checksums from the cell's own endpoints equal the export's, table by table;
- the Order placed after the export is gone, as the restore warned;
- Harbor Goods' checksums in pool-1 are the same before and after;
- the storefront shows the restored products.

## Exports on the cluster

The platform worker has exported every ACTIVE shop every 15 minutes since #62 (04:24) to the PVC `tenant-exports`, mounted only by the worker. At 12:50 it held 83 exports of 12 shops, 39 MB, the newest 8 of each shop (the oldest of the 8 from 07:22, two hours earlier, as 15-minute rounds keeping 8 should). The worker counted 13 exports, 1 move, 1 restore, 1 deletion, and 2 provisionings since its last restart (`platform_lifecycle_completed_total`).

## Phase 6's releases through the waves

Every release went canary, then pool-1, then dedicated-1, with no human step:

| PR | Merged | Wave 1 | Wave 2 |
|---|---|---|---|
| #59 export, import, checksums | 21:47 | 21:56 | 22:04 |
| #60 read-only freeze, faster Order import | 22:30 | 22:39 | 22:46 |
| #61 tenant move | 00:05 | 00:19 | 00:26 |
| #62 exports and restore | 04:22 | 04:34 | 07:23 |
| #63 Merchant product deletion, the experiments | 12:22 | 12:38 | 12:44 |

#62's wave 2 came 3 hours after its wave 1, because the laptop slept from 04:31 to about 07:17 (`pmset` shows 28 sleeps, with only dark wakes between). The promoter re-dispatched the wave on each wake, and pool-1 settled on the release at 07:17.

After each merge the endpoints were checked on the cluster, each cell with its own token:
- #59: the checksums in every cell, and 401 without the token.
- #60: a pool-1 shop set `MOVING` answered its home page 200 and a Cart add 503 with the updating page, then 303 once `ACTIVE` again.
- #61: refused moves answered `no_capacity`, `canary_cell`, `unknown_cell`.

## What broke, and what held

- **The Order import was quadratic** (#59, fixed in #60). Its status steps joined the Orders with ids read out of the JSON, comparing every Order with every exported row. Harbor's 3,072 Orders took 2.8 s for one step, and the import passed the APIs' 5 s statement timeout (500). As index lookups over an array of ids, a step takes 34 ms. The full suite found it: the Harbor that the earlier suites had grown was bigger than the one the ticket's first test run used.
- **Exports held up a move** (found while building #62). Sharing the lifecycle worker's loop, a round of every Compose shop's export (395 shops, 106 s) kept a move `MOVING` past its test's timeout. A test's refusal case ("dedicated-1 is full") then found dedicated-1 empty and moved Meadow Supply there for real. Meadow was put back with the cell endpoints, with equal checksums, and the case now runs only when dedicated-1 is taken. Exports now have their own loop, are asked for at most 20 per tick, and an operator's export goes first.
- **The Merchant's product delete first broke the Phase 2 rule** that runtime identities have no DELETE (ADR-0016's tests caught it). It runs through a narrow function scoped to the transaction's tenant instead.
- **Held:**
  - A worker killed between a move's switch and its source purge resumed the move after restarting (Compose).
  - A move whose target API was down was undone, the shop ACTIVE again where it was within seconds (Compose).
  - A restore whose export could not be read put the shop back unchanged (Compose).

## Memory

Measured at 12:50 with three cells, the promoter, the four dashboards, and the exports; the Compose stack stopped.

| | Phase 5 | Phase 6 |
|---|---|---|
| Colima VM used / available | 4,366 / 3,556 MiB | 5,340 / 2,581 MiB |
| k3d node | 5,182 MiB | 4,067 MiB |
| Cells (pool-1, canary, dedicated-1) | 255, 253, 257 MiB | 229, 224, 200 MiB |
| Edge | 48 MiB | 41 MiB |
| `platform-dev` | 208 MiB | 152 MiB |
| Argo CD / monitoring | 685 / 1,332 MiB | 552 / 1,044 MiB |

Moves, exports, and restores added no unit; the export volume holds 39 MB. The VM used more memory in all than in Phase 5, mostly page cache, and has 2.5 GB to spare.

## Gaps and follow-ups

- **A moved shop's buyers and Merchant sign in again.** Order tokens and Merchant sessions are signed with each cell's own secret, so a buyer's link to an Order placed before the move no longer opens, and the Merchant's session ends. Signing them with a per-tenant secret the control plane holds would carry them across.
- **A restore loses everything since its export**, Orders included. Point-in-time recovery is the change to make when the lab has room (README; ADR-0030).
- An export reads a shop's catalog and Orders in two statements, which are not one snapshot. An export from before a migration that adds a column imports that column as NULL.
- A move or restore holds the shop's rows in the worker's memory, one request per API: enough for the lab's shops, not for large ones.
- Exports are unencrypted, on the lab's one node (Phases 7 and 8).
- From Phase 5:
  - the synthetic prober's interval should count from each round's start;
  - a CI check that applies the cell manifests to a scratch cluster;
  - an alert for a release stuck unsettled in wave 0;
  - a second edge replica.
