# 05: Product quota by plan, visible to the Merchant

**What to build:** The catalog API refuses a product over the plan's limit; the Merchant admin shows products used against the limit and the plan's request rate, and explains a refusal.

**Blocked by:** 01 (deployed)

**Status:** in review

- [ ] `409 product_quota` from the catalog API (count under the tenant's RLS scope, in the insert's transaction)
- [ ] Admin: "N of M products", the request quota, the refusal message on the add form
- [ ] Seam-1 test: a starter shop's product 101 is refused and the admin shows 100 of 100

## Comments

Implementation notes (2026-10-13):
- The catalog API counts the shop's products and inserts in one transaction, under an advisory lock per shop, so concurrent adds cannot both take the last place. Over `planLimits[plan].products` (starter 100, plus 5,000, synthetic 10): `409 {"error":"product_quota"}`.
- `GET /admin/usage` (admin token, tenant context) returns the plan, the products, the product limit, and the request rate and burst (`AdminUsage` in contracts).
- The Merchant admin shows "Plan starter: N of M products; up to R requests a second (bursts of B)" on the orders page and the add form. A refusal lands on the form with "Your plan allows M products, and this shop has N."
  - A storefront that meets an older catalog API while its cell rolls gets 404 from `/admin/usage` and omits the line, rather than failing the page.
- `PRODUCT_QUOTA_EXEMPT`: none in the cluster. Compose exempts `harbor` and `meadow`, whose catalogs grow with every test run on a volume that outlives the stack.
- The catalog API now depends on `@shop/tenancy` for `planLimits`; its Dockerfile already copied the package.

Tests (`product-quota.test.ts`):
- A signed-up starter shop takes 100 products and refuses the 101st with `product_quota`, and the usage endpoint reports 100 of 100.
- Its Merchant's admin shows "100 of 100 products", and adding one more lands on the form's quota message.
- Six concurrent adds at 99 products: exactly one is accepted.

Runs, all with the cluster stopped:
- The first two hung. Colima's Docker stopped answering while the host had about 130 MB free, and the promoter test's synchronous `compose up --build` blocked vitest past its own timeout. Colima was restarted (the author agreed); the host then had 3.7 GB free.
- The third ran in 900 s with 38 of 40 files passing. Two failures: a test mistake (React splits the page's text with `<!-- -->`, so the match now strips them), and `cells.test.ts`'s synthetic shop check not recorded within 15 s on the slow host.
- Rerun, both files passed (15 tests).
