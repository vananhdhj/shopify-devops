// The promoter's decisions, as pure functions over what it observed (Phase 4): which wave holds a
// release the next wave lacks, and whether a soak passed its gate. No I/O here, so every rule is
// tested without a cluster.

/** A release: the digest of each of the platform's images a cell runs, {"<image>": "sha256:…"}. */
export type Release = Record<string, string>;

/** One cell as Argo CD reports it. */
export interface CellState {
  cell: string;
  wave: number;
  namespace: string;
  synced: boolean;
  healthy: boolean;
  release: Release;
}

/** A release's identity: its images and digests in a fixed order. */
export function releaseKey(release: Release): string {
  return Object.keys(release)
    .sort()
    .map((image) => `${image}@${release[image]}`)
    .join(",");
}

/** The release every cell of a wave runs, or undefined while they differ (a rollout in progress). */
export function waveRelease(cells: CellState[]): Release | undefined {
  const first = cells[0];
  if (!first) return undefined;
  const key = releaseKey(first.release);
  return cells.every((cell) => releaseKey(cell.release) === key) ? first.release : undefined;
}

/** Whether `cells` all run every digest of `release` (they may run other images too). */
export function runsRelease(cells: CellState[], release: Release): boolean {
  return cells.length > 0 && cells.every((cell) => Object.entries(release).every(([image, digest]) => cell.release[image] === digest));
}

export interface Candidate {
  /** The wave being soaked; its release goes to wave + 1 if the gate passes. */
  wave: number;
  release: Release;
  cells: CellState[];
}

/**
 * Every wave whose cells agree on a release the next wave does not run yet, and so must be soaked
 * before promotion. The last wave has no next wave and is never a candidate.
 */
export function candidates(cells: CellState[]): Candidate[] {
  const waves = [...new Set(cells.map((cell) => cell.wave))].sort((a, b) => a - b);
  const result: Candidate[] = [];
  for (const wave of waves) {
    const here = cells.filter((cell) => cell.wave === wave);
    const next = cells.filter((cell) => cell.wave === wave + 1);
    const release = waveRelease(here);
    if (release && Object.keys(release).length > 0 && next.length > 0 && !runsRelease(next, release)) {
      result.push({ wave, release, cells: here });
    }
  }
  return result;
}

/** One cell's gate checks at one tick. Null metrics mean Prometheus had no sample. */
export interface CellChecks {
  cell: string;
  /** Synced and Healthy on the release being soaked. */
  deployed: boolean;
  /** 5xx share of the cell's requests over the last 2 minutes. */
  errorRatio: number | null;
  /** Age of the cell's oldest Pending Order. */
  oldestPendingSeconds: number | null;
  firingAlerts: number;
  /** The synthetic Checkout finished since the last tick: passed, failed, or none finished. */
  synthetic: "passed" | "failed" | "none";
}

export interface GateLimits {
  maxErrorRatio: number;
  maxOldestPendingSeconds: number;
  /** A check halts the release only after failing on this many ticks in a row (one blip is noise). */
  failuresToHalt: number;
  /** Synthetic Checkouts each cell must have passed by the end of the soak. */
  minSyntheticPasses: number;
}

export const defaultLimits: GateLimits = { maxErrorRatio: 0.05, maxOldestPendingSeconds: 60, failuresToHalt: 2, minSyntheticPasses: 3 };

/** The gate's memory across ticks, kept in the promotion's row so a restarted promoter resumes. */
export interface GateRecord {
  ticks: number;
  /** Consecutive failing ticks per `<cell>/<check>`. */
  failing: Record<string, number>;
  syntheticPasses: Record<string, number>;
  failure?: { cell: string; check: string; detail: string };
}

export const emptyGate = (): GateRecord => ({ ticks: 0, failing: {}, syntheticPasses: {} });

type CheckName = "deployed" | "error_ratio" | "oldest_pending" | "alerts" | "synthetic";

function failures(checks: CellChecks, limits: GateLimits): { check: CheckName; detail: string }[] {
  const failed: { check: CheckName; detail: string }[] = [];
  if (!checks.deployed) failed.push({ check: "deployed", detail: "not Synced and Healthy on the release" });
  if (checks.errorRatio !== null && checks.errorRatio > limits.maxErrorRatio) {
    failed.push({ check: "error_ratio", detail: `5xx ratio ${checks.errorRatio.toFixed(3)} over ${limits.maxErrorRatio}` });
  }
  if (checks.oldestPendingSeconds !== null && checks.oldestPendingSeconds > limits.maxOldestPendingSeconds) {
    failed.push({ check: "oldest_pending", detail: `an Order Pending for ${Math.round(checks.oldestPendingSeconds)} s` });
  }
  if (checks.firingAlerts > 0) failed.push({ check: "alerts", detail: `${checks.firingAlerts} alert(s) firing` });
  if (checks.synthetic === "failed") failed.push({ check: "synthetic", detail: "the synthetic Checkout did not complete" });
  return failed;
}

export type Verdict = { verdict: "soaking" | "passed"; gate: GateRecord } | { verdict: "halted"; gate: GateRecord };

/**
 * Folds one tick's checks into the gate. A check that fails on `failuresToHalt` ticks in a row
 * halts the release; a passing tick resets that check's count. The gate passes once the soak has
 * lasted `soakSeconds` and every cell passed enough synthetic Checkouts.
 */
export function judge(
  previous: GateRecord,
  ticks: CellChecks[],
  soakedSeconds: number,
  soakSeconds: number,
  limits: GateLimits = defaultLimits,
): Verdict {
  const gate: GateRecord = {
    ticks: previous.ticks + 1,
    failing: { ...previous.failing },
    syntheticPasses: { ...previous.syntheticPasses },
  };
  for (const checks of ticks) {
    const failed = failures(checks, limits);
    for (const name of ["deployed", "error_ratio", "oldest_pending", "alerts", "synthetic"] as const) {
      const key = `${checks.cell}/${name}`;
      const failure = failed.find((f) => f.check === name);
      // A tick with no finished synthetic Checkout neither fails nor clears that check.
      if (name === "synthetic" && checks.synthetic === "none") continue;
      gate.failing[key] = failure ? (gate.failing[key] ?? 0) + 1 : 0;
      if (failure && gate.failing[key]! >= limits.failuresToHalt) {
        return { verdict: "halted", gate: { ...gate, failure: { cell: checks.cell, check: name, detail: failure.detail } } };
      }
    }
    if (checks.synthetic === "passed") gate.syntheticPasses[checks.cell] = (gate.syntheticPasses[checks.cell] ?? 0) + 1;
  }
  const enoughSynthetic = ticks.every((checks) => (gate.syntheticPasses[checks.cell] ?? 0) >= limits.minSyntheticPasses);
  const clean = Object.values(gate.failing).every((count) => count === 0);
  return { verdict: soakedSeconds >= soakSeconds && enoughSynthetic && clean ? "passed" : "soaking", gate };
}
