/**
 * Checkouts in flight per tenant in this process (Phase 5): a shop over its plan's cap is told to
 * retry instead of queueing for the cell's database connections, which every shop shares.
 */
export class InFlight {
  private counts = new Map<string, number>();

  /** Takes a slot for `key` if fewer than `limit` are taken; the caller must `release` it. */
  tryTake(key: string, limit: number): boolean {
    const taken = this.counts.get(key) ?? 0;
    if (taken >= limit) return false;
    this.counts.set(key, taken + 1);
    return true;
  }

  release(key: string): void {
    const taken = (this.counts.get(key) ?? 1) - 1;
    if (taken <= 0) this.counts.delete(key);
    else this.counts.set(key, taken);
  }

  taken(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
