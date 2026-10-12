import type { Pool } from "pg";
import { type Queryable, withTransaction } from "@shop/service-kit";
import {
  type CellChecks,
  type CellState,
  type Candidate,
  type GateLimits,
  type GateRecord,
  type Release,
  candidates,
  emptyGate,
  judge,
  releaseKey,
  runsRelease,
  waveRelease,
} from "./promotion-gate.ts";

/** What the promoter reads and calls; the server wires the real sources, the tests stubs. */
export interface PromoterDeps {
  db: Pool;
  cells(): Promise<CellState[]>;
  metrics(namespace: string): Promise<{ errorRatio: number | null; oldestPendingSeconds: number | null; firingAlerts: number }>;
  syntheticCheckout(handle: string): Promise<boolean>;
  dispatch(wave: number, release: Release, gate: string): Promise<void>;
  soakSeconds: number;
  limits: GateLimits;
  /** A dispatched promotion not seen in the next wave after this long is dispatched again. */
  redispatchAfterSeconds: number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export interface PromotionRow {
  id: string;
  release_key: string;
  digests: Release;
  wave: number;
  cells: string[];
  state: "soaking" | "promoting" | "promoted" | "halted" | "superseded";
  soak_started_at: Date;
  dispatched_at: Date | null;
  gate: GateRecord;
}

/** What one tick saw, for metrics: per wave being soaked, the state of its current release. */
export type TickReport = { wave: number; state: PromotionRow["state"]; checks: { cell: string; check: string; outcome: string }[] }[];

async function event(db: Queryable, promotionId: string, step: string, detail: object = {}) {
  await db.query("INSERT INTO platform.promotion_events (promotion_id, step, detail) VALUES ($1, $2, $3)", [promotionId, step, detail]);
}

async function setState(db: Pool, row: PromotionRow, state: PromotionRow["state"], fields: Record<string, unknown> = {}) {
  const columns = Object.keys(fields);
  await db.query(
    `UPDATE platform.promotions SET state = $2, updated_at = now()${columns.map((c, i) => `, ${c} = $${i + 3}`).join("")} WHERE id = $1`,
    [row.id, state, ...columns.map((c) => fields[c])],
  );
}

/**
 * Moves releases through the waves (Phase 4, spec decisions 1–5). Each tick:
 *   - a release a wave runs and the next wave lacks is soaked: from the first tick it is seen, the
 *     gate is checked every tick (Argo CD's state, the cell's metrics, a synthetic Checkout);
 *   - a soak that lasted `soakSeconds` with every check passing dispatches the promote workflow
 *     for the next wave, once; a check failing on consecutive ticks halts the release for good;
 *   - a dispatched release is marked promoted once the next wave runs it.
 * Everything is recorded in `platform.promotions`, so a restarted promoter resumes a soak where
 * it was, and a release is never soaked, dispatched, or halted twice.
 */
export class Promoter {
  /** Synthetic Checkouts in flight or finished since the last tick, per cell. */
  private synthetic = new Map<string, { done: boolean; passed: boolean }>();

  constructor(private deps: PromoterDeps) {}

  async tick(): Promise<TickReport> {
    const { db } = this.deps;
    const cells = await this.deps.cells();
    await this.settle(cells);

    const report: TickReport = [];
    const synthetics = await this.syntheticShops();
    for (const candidate of candidates(cells)) {
      const key = releaseKey(candidate.release);
      const { rows } = await db.query<PromotionRow>(
        "SELECT * FROM platform.promotions WHERE release_key = $1 AND wave = $2",
        [key, candidate.wave],
      );
      let row = rows[0];
      if (!row) {
        row = await this.startSoak(candidate, key);
      }
      if (row.state === "soaking") {
        report.push(await this.gate(row, candidate, cells, synthetics));
      } else {
        if (row.state === "promoting") await this.redispatchIfLost(row);
        report.push({ wave: candidate.wave, state: row.state, checks: [] });
      }
    }
    return report;
  }

  /** Releases soaking or promoting that the fleet has since moved past or away from. */
  private async settle(cells: CellState[]) {
    const { rows } = await this.deps.db.query<PromotionRow>("SELECT * FROM platform.promotions WHERE state IN ('soaking', 'promoting')");
    for (const row of rows) {
      const next = cells.filter((cell) => cell.wave === row.wave + 1);
      const here = cells.filter((cell) => cell.wave === row.wave);
      if (runsRelease(next, row.digests)) {
        await setState(this.deps.db, row, "promoted", { decided_at: new Date() });
        await event(this.deps.db, row.id, "promoted", { wave: row.wave + 1, cells: next.map((cell) => cell.cell) });
        this.deps.log.info({ promotion: row.id, wave: row.wave + 1 }, "release reached the next wave");
      } else if (!runsRelease(here, row.digests) && waveRelease(here) !== undefined) {
        // The wave settled on another release (a newer one, or a revert) before this one moved on.
        await setState(this.deps.db, row, "superseded", { decided_at: new Date() });
        await event(this.deps.db, row.id, "superseded", { now: releaseKey(waveRelease(here)!) });
      }
    }
  }

  private async startSoak(candidate: Candidate, key: string): Promise<PromotionRow> {
    return withTransaction(this.deps.db, async (client) => {
      const { rows } = await client.query<PromotionRow>(
        `INSERT INTO platform.promotions (release_key, digests, wave, cells, state)
         VALUES ($1, $2, $3, $4, 'soaking') RETURNING *`,
        [key, candidate.release, candidate.wave, candidate.cells.map((cell) => cell.cell)],
      );
      const row = rows[0]!;
      await event(client, row.id, "soak_started", { wave: candidate.wave, cells: row.cells, soakSeconds: this.deps.soakSeconds });
      this.deps.log.info({ promotion: row.id, wave: candidate.wave, cells: row.cells }, "soaking a release");
      return row;
    });
  }

  /** The handle of each cell's synthetic shop. */
  private async syntheticShops(): Promise<Map<string, string>> {
    const { rows } = await this.deps.db.query<{ cell: string; handle: string }>(
      "SELECT cell, handle FROM platform.tenants WHERE internal AND status = 'ACTIVE' AND cell IS NOT NULL",
    );
    return new Map(rows.map((row) => [row.cell, row.handle]));
  }

  /** The finished synthetic Checkout of a cell since the last tick, starting the next one. */
  private syntheticResult(cell: string, handle: string | undefined): CellChecks["synthetic"] {
    if (!handle) return "failed";
    const current = this.synthetic.get(cell);
    if (current && !current.done) return "none";
    const next = { done: false, passed: false };
    this.synthetic.set(cell, next);
    this.deps
      .syntheticCheckout(handle)
      .then((passed) => Object.assign(next, { done: true, passed }))
      .catch(() => Object.assign(next, { done: true, passed: false }));
    if (!current) return "none";
    return current.passed ? "passed" : "failed";
  }

  private async gate(row: PromotionRow, candidate: Candidate, cells: CellState[], synthetics: Map<string, string>) {
    const checks: CellChecks[] = [];
    for (const cell of candidate.cells) {
      const metrics = await this.deps.metrics(cell.namespace).catch((err) => {
        this.deps.log.warn({ err, cell: cell.cell }, "metrics unavailable this tick");
        return { errorRatio: null, oldestPendingSeconds: null, firingAlerts: 0 };
      });
      checks.push({
        cell: cell.cell,
        deployed: cell.synced && cell.healthy && runsRelease([cell], row.digests),
        ...metrics,
        synthetic: this.syntheticResult(cell.cell, synthetics.get(cell.cell)),
      });
    }
    const soaked = (Date.now() - row.soak_started_at.getTime()) / 1000;
    const result = judge(row.gate ?? emptyGate(), checks, soaked, this.deps.soakSeconds, this.deps.limits);
    const outcomes = checks.flatMap((c) => [
      { cell: c.cell, check: "deployed", outcome: c.deployed ? "pass" : "fail" },
      { cell: c.cell, check: "synthetic", outcome: c.synthetic === "none" ? "pending" : c.synthetic === "passed" ? "pass" : "fail" },
    ]);

    if (result.verdict === "halted") {
      const exposed = cells.filter((cell) => cell.wave <= candidate.wave && runsRelease([cell], row.digests)).map((cell) => cell.cell);
      const { rows: counted } = await this.deps.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM platform.tenants WHERE cell = ANY($1) AND NOT internal AND status <> 'DELETED'",
        [exposed],
      );
      const tenants = counted[0]!.n;
      await setState(this.deps.db, row, "halted", {
        gate: result.gate,
        decided_at: new Date(),
        exposed_cells: exposed,
        exposed_tenants: tenants,
      });
      await event(this.deps.db, row.id, "halted", { ...result.gate.failure, exposedCells: exposed, exposedTenants: tenants });
      this.deps.log.warn({ promotion: row.id, wave: candidate.wave, failure: result.gate.failure, exposed, tenants }, "release halted");
      return { wave: candidate.wave, state: "halted" as const, checks: outcomes };
    }
    if (result.verdict === "passed") {
      const summary = `soaked ${Math.round(soaked)} s in wave ${candidate.wave} (${row.cells.join(", ")}), ${result.gate.ticks} ticks, synthetic Checkouts ${JSON.stringify(result.gate.syntheticPasses)}`;
      await this.deps.db.query("UPDATE platform.promotions SET gate = $2, updated_at = now() WHERE id = $1", [row.id, result.gate]);
      await this.deps.dispatch(candidate.wave + 1, row.digests, summary);
      await setState(this.deps.db, row, "promoting", { dispatched_at: new Date() });
      await event(this.deps.db, row.id, "dispatched", { wave: candidate.wave + 1, summary });
      this.deps.log.info({ promotion: row.id, wave: candidate.wave + 1, summary }, "gate passed; promotion dispatched");
      return { wave: candidate.wave, state: "promoting" as const, checks: outcomes };
    }
    await this.deps.db.query("UPDATE platform.promotions SET gate = $2, updated_at = now() WHERE id = $1", [row.id, result.gate]);
    return { wave: candidate.wave, state: "soaking" as const, checks: outcomes };
  }

  private async redispatchIfLost(row: PromotionRow) {
    if (!row.dispatched_at || Date.now() - row.dispatched_at.getTime() < this.deps.redispatchAfterSeconds * 1000) return;
    await this.deps.dispatch(row.wave + 1, row.digests, "dispatched again: the first dispatch did not reach the next wave");
    await setState(this.deps.db, row, "promoting", { dispatched_at: new Date() });
    await event(this.deps.db, row.id, "redispatched", { wave: row.wave + 1 });
  }
}
