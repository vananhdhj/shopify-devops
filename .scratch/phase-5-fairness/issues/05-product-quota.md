# 05: Product quota by plan, visible to the Merchant

**What to build:** The catalog API refuses a product over the plan's limit; the Merchant admin shows products used against the limit and the plan's request rate, and explains a refusal.

**Blocked by:** 01 (deployed)

**Status:** ready-for-agent

- [ ] `409 product_quota` from the catalog API (count under the tenant's RLS scope, in the insert's transaction)
- [ ] Admin: "N of M products", the request quota, the refusal message on the add form
- [ ] Seam-1 test: a starter shop's product 101 is refused and the admin shows 100 of 100
