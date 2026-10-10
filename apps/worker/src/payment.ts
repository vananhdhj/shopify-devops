import type { PaymentScenario } from "@shop/contracts";

export type PaymentResult = "approved" | "declined";

/**
 * The simulated payment. Its result is fixed by the Payment scenario stored on the Order, so a
 * retry can never re-roll it. `slow` waits before approving, which also gives tests a window
 * after the Stock deduction in which to crash the worker.
 */
export async function simulatePayment(scenario: PaymentScenario, slowDelayMs: number): Promise<PaymentResult> {
  if (scenario === "decline") return "declined";
  if (scenario === "slow") await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
  return "approved";
}
