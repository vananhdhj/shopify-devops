# 05: Close Phase 6 — move and restore experiments

**What to build:** The exit gate on the lab cluster, then ADRs, glossary, and evidence.

**Blocked by:** 03, 04

**Status:** in progress (experiments scripted; run once this PR is through the waves)

- [ ] `make experiment-tenant-move`: dedicated-1 freed of its test shop; a starter shop with products, Carts, and Pending Orders moves pool-1 → dedicated-1; freeze under 30 s; counts and checksums equal; Orders before = after; Pending settle; a probe through the ingress sees browsing answered throughout
- [ ] `make experiment-tenant-restore`: products deleted, restored from the export before; another shop's rows unchanged
- [ ] `docs/evidence/<date>-phase-6-cluster.md`
- [ ] ADRs: moves copy, freeze, and verify; a read-only freeze through the signed context; restore points are exports (PITR deferred)
- [ ] `CONTEXT.md`: Tenant move, Write freeze, Tenant export, Restore point
- [ ] Spec status resolved

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
