# 05: Close Phase 6 — move and restore experiments

**What to build:** The exit gate on the lab cluster, then ADRs, glossary, and evidence.

**Blocked by:** 03, 04

**Status:** resolved

- [x] `make experiment-tenant-move`: dedicated-1 freed of its test shop; a starter shop with products, Carts, and Pending Orders moves pool-1 → dedicated-1; freeze under 30 s; counts and checksums equal; Orders before = after; Pending settle; a probe through the ingress sees browsing answered throughout
- [x] `make experiment-tenant-restore`: products deleted, restored from the export before; another shop's rows unchanged
- [x] `docs/evidence/<date>-phase-6-cluster.md`
- [x] ADRs: moves copy, freeze, and verify; a read-only freeze through the signed context; restore points are exports (PITR deferred)
- [x] `CONTEXT.md`: Tenant move, Write freeze, Tenant export, Restore point
- [x] Spec status resolved

## Comments

Implementation notes, first PR (2026-10-14):
- **A Merchant deletes a product** (needed for the restore experiment's destructive action; the admin had none):
  - the admin page lists the catalog, each product with a Delete button (`POST /admin/products/:id/delete`), and says "Product deleted.";
  - the catalog API has `DELETE /admin/products/:id` (admin token, tenant context; 204, or 404 for none or another shop's).
  - It runs through `catalog.delete_product(id)` (migration `20261014000009`), a narrow SECURITY DEFINER function scoped to the transaction's `app.tenant_id`: the catalog identity keeps no DELETE of its own (the Phase 2 rule `lifecycle.test.ts` holds; a first version granted DELETE and broke it). The product leaves every Cart first; Orders keep their own lines.
  - A storefront that meets a catalog API of the previous release gets a 404 and says the product is no longer there.
- `make experiment-tenant-move` (`scripts/experiment-tenant-move.sh`):
  1. frees dedicated-1 (deletes its shops; the synthetic one stays);
  2. creates a starter shop with 3 products, Carts, an approved and a declined Order, and 3 slow (Pending) Orders placed just before the move;
  3. probes through the ingress the home page 4 times a second and a Cart add once a second;
  4. runs `make tenant-move`.

  The bound: frozen under 30 s; the shop plus and ACTIVE in dedicated-1; the same Order ids before and after with none Pending; no row of it in pool-1; every browse answered 200; the home page served from dedicated-1.
- `make experiment-tenant-restore` (`scripts/experiment-tenant-restore.sh`):
  1. creates a starter shop with 4 products and an Order;
  2. takes an on-demand export;
  3. a buyer's Order, then the Merchant deletes 2 products in the admin;
  4. `make tenant-restore`.

  The bound: the 4 products back; the shop's checksums (from the cell's endpoints) equal the export's; the later Order gone; a neighbour shop's checksums unchanged; the storefront shows the restored products.

`make test CELLS=2` with the cluster stopped: 47 files, 245 tests passed (402 s).

Resolved 2026-10-14. PR #63 (`eeaf513`) went through the waves (pool-1 12:38, dedicated-1 12:44 UTC). Then on the cluster, with the VM's load under 4 ([Phase 6 evidence](../../../docs/evidence/2026-10-14-phase-6-cluster.md)):
- **`make experiment-tenant-move`**: dedicated-1 was freed of `plus-a2d37b`, and `mv-exp-5ee0b6` moved from pool-1, frozen 5,271 ms. Every table's count and md5 was equal; the same 5 Orders (3 Pending at the freeze) were there after, none Pending; no row was left in pool-1; 60 of 60 home-page requests answered 200 through the ingress. Cart adds were refused 4 times over 3.4 s.
- **`make experiment-tenant-restore`**: `rs-exp-3d432a` lost 2 products to its Merchant's deletes after an export and got them back, frozen 5,095 ms. The checksums equal the export's, the later Order is gone, and Harbor's checksums are unchanged.
- ADRs 0028 (moves copy, freeze, and verify), 0029 (the read-only freeze through the signed context), 0030 (restore points are scheduled exports; PITR deferred).
- `CONTEXT.md`: Write freeze, Tenant move, Tenant export, Restore point.
- README: the operator's commands, Phase 6's row in the results, and the moved shop's signing gap in the known limits.
