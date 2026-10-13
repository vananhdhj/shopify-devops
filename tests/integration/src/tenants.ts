import type { TenantContext } from "@shop/tenancy";

/**
 * The two shops seeded in Phase 1, as the control plane's registry seed enters them
 * (db/platform/seed.sql). Credential version 1 unless a test bumps it.
 */
export const tenants = {
  harbor: { id: "10000000-0000-4000-8000-000000000001", handle: "harbor", name: "Harbor Goods", credentialVersion: 1, plan: "starter" },
  meadow: { id: "10000000-0000-4000-8000-000000000002", handle: "meadow", name: "Meadow Supply", credentialVersion: 1, plan: "starter" },
} as const satisfies Record<string, TenantContext>;
