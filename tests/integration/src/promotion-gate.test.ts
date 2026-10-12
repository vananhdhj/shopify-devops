import { describe, expect, it } from "vitest";
import {
  type CellChecks,
  type CellState,
  candidates,
  defaultLimits,
  emptyGate,
  judge,
  releaseKey,
  waveRelease,
} from "../../../apps/platform/src/promotion-gate.ts";

// The promoter's decisions (Phase 4), as pure functions: no stack needed.
const A = { "img/storefront": "sha256:a1", "img/worker": "sha256:a2" };
const B = { "img/storefront": "sha256:b1", "img/worker": "sha256:a2" };
const cell = (name: string, wave: number, release: Record<string, string>, ok = true): CellState => ({
  cell: name,
  wave,
  namespace: `ns-${name}`,
  synced: ok,
  healthy: ok,
  release,
});
const fine = (name: string, synthetic: CellChecks["synthetic"] = "passed"): CellChecks => ({
  cell: name,
  deployed: true,
  errorRatio: 0,
  oldestPendingSeconds: null,
  firingAlerts: 0,
  synthetic,
});

describe("which wave holds a release to soak", () => {
  it("is the wave whose cells agree on a release the next wave lacks", () => {
    expect(candidates([cell("canary", 0, B), cell("pool-1", 1, A), cell("dedicated-1", 2, A)])).toEqual([
      { wave: 0, release: B, cells: [cell("canary", 0, B)] },
    ]);
    // Wave 1 has it now: wave 1 is soaked next, wave 0 is done.
    expect(candidates([cell("canary", 0, B), cell("pool-1", 1, B), cell("dedicated-1", 2, A)]).map((c) => c.wave)).toEqual([1]);
    // The last wave never is; a fleet on one release has nothing to do.
    expect(candidates([cell("canary", 0, B), cell("pool-1", 1, B), cell("dedicated-1", 2, B)])).toEqual([]);
  });

  it("waits while a wave's cells run different releases (a rollout in progress)", () => {
    expect(waveRelease([cell("p1", 1, A), cell("p2", 1, B)])).toBeUndefined();
    expect(candidates([cell("canary", 0, B), cell("p1", 1, A), cell("p2", 1, B), cell("d1", 2, A)]).map((c) => c.wave)).toEqual([0]);
  });

  it("waits while a wave's cell is still rolling (its images a mix of two releases)", () => {
    expect(candidates([cell("canary", 0, B, false), cell("pool-1", 1, A), cell("dedicated-1", 2, A)])).toEqual([]);
  });

  it("names a release by its digests, whatever their order", () => {
    expect(releaseKey({ "img/worker": "sha256:a2", "img/storefront": "sha256:a1" })).toBe(releaseKey(A));
    expect(releaseKey(A)).not.toBe(releaseKey(B));
  });
});

describe("the gate", () => {
  it("passes once the soak has lasted and every cell passed enough synthetic Checkouts", () => {
    let gate = emptyGate();
    for (let tick = 0; tick < 2; tick++) {
      const r = judge(gate, [fine("canary")], 10 * tick, 30);
      expect(r.verdict).toBe("soaking");
      gate = r.gate;
    }
    // Long enough, but only two synthetic passes so far.
    expect(judge(gate, [fine("canary", "none")], 31, 30).verdict).toBe("soaking");
    expect(judge(gate, [fine("canary")], 31, 30).verdict).toBe("passed");
  });

  it("halts only when a check fails on consecutive ticks", () => {
    const failing = { ...fine("canary"), errorRatio: 0.2 };
    const once = judge(emptyGate(), [failing], 0, 30);
    expect(once.verdict).toBe("soaking");
    // A passing tick clears the count: one blip never halts.
    const recovered = judge(once.gate, [fine("canary")], 15, 30);
    expect(recovered.gate.failing["canary/error_ratio"]).toBe(0);
    const twice = judge(judge(recovered.gate, [failing], 20, 30).gate, [failing], 25, 30);
    expect(twice).toMatchObject({ verdict: "halted", gate: { failure: { cell: "canary", check: "error_ratio" } } });
  });

  it("counts every check: deployment, Pending Orders, alerts, the synthetic Checkout", () => {
    const halts = (checks: CellChecks) => judge(judge(emptyGate(), [checks], 0, 30).gate, [checks], 15, 30).verdict;
    expect(halts({ ...fine("c"), deployed: false })).toBe("halted");
    expect(halts({ ...fine("c"), oldestPendingSeconds: defaultLimits.maxOldestPendingSeconds + 1 })).toBe("halted");
    expect(halts({ ...fine("c"), firingAlerts: 1 })).toBe("halted");
    expect(halts({ ...fine("c"), synthetic: "failed" })).toBe("halted");
    // No traffic or no Pending Order is no evidence against the release.
    expect(halts({ ...fine("c"), errorRatio: null, oldestPendingSeconds: null })).toBe("soaking");
  });

  it("does not pass while a check is failing, even after the soak", () => {
    let gate = emptyGate();
    for (let tick = 0; tick < 3; tick++) gate = judge(gate, [fine("canary")], 0, 30).gate;
    expect(judge(gate, [{ ...fine("canary"), firingAlerts: 1 }], 40, 30).verdict).toBe("soaking");
  });
});
