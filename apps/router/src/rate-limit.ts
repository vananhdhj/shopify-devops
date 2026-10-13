/**
 * Token buckets, one per key (a tenant, or a client address at the platform's own domain), in the
 * edge's memory (Phase 5, decision 3). A bucket holds up to `burst` tokens and refills at `rate`
 * tokens a second, continuously; a request takes one token or is refused with the whole seconds
 * until one is back. Exact with one edge replica; with N replicas each lets the full rate through.
 */
export interface Limit {
  /** Tokens added per second. */
  rate: number;
  /** The most tokens a bucket holds: the requests allowed at once above the sustained rate. */
  burst: number;
}

export type Decision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /** Buckets idle this long are full again, so they are dropped to bound the map. */
  constructor(private idleMs = 60_000) {}

  take(key: string, limit: Limit, now = Date.now()): Decision {
    if (!Number.isFinite(limit.rate)) return { allowed: true };
    const previous = this.buckets.get(key) ?? { tokens: limit.burst, at: now };
    const tokens = Math.min(limit.burst, previous.tokens + ((now - previous.at) / 1000) * limit.rate);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at: now });
      return { allowed: true };
    }
    this.buckets.set(key, { tokens, at: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / limit.rate)) };
  }

  /** Drops buckets untouched for `idleMs`: they would be full, which is what a missing bucket means. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.at > this.idleMs) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}
