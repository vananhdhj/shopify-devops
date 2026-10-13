import type { AdminUsage } from "@shop/contracts";

/** The shop's use of its plan (Phase 5): products against the quota, and the request rate. */
export function Usage({ usage }: { usage: AdminUsage | undefined }) {
  if (!usage) return null;
  return (
    <p className="hint">
      Plan {usage.plan}: {usage.products} of {usage.productLimit} products; up to {usage.requestsPerSecond} requests a second
      (bursts of {usage.burst}).
    </p>
  );
}
