import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTenantTable, type Tenant } from "@shop/tenancy";

const tableFile = fileURLToPath(new URL("../../../deploy/base/tenants.json", import.meta.url));

function byHandle(handle: string): Tenant {
  const tenant = parseTenantTable(readFileSync(tableFile, "utf8")).find((entry) => entry.handle === handle);
  if (!tenant) throw new Error(`tenant ${handle} missing from deploy/base/tenants.json`);
  return tenant;
}

/** The two seeded shops, as the static tenant table defines them. */
export const tenants = {
  harbor: byHandle("harbor"),
  meadow: byHandle("meadow"),
} as const;
