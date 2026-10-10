import type { ConnectionOptions, JobsOptions } from "bullmq";

export const ordersQueue = "orders";

export interface SettleOrderJob {
  orderId: string;
}

/** The slice of a BullMQ queue the dispatcher uses. */
export interface JobSink {
  add(name: string, data: SettleOrderJob, opts: JobsOptions): Promise<unknown>;
}

/** The slice of a BullMQ queue the metrics read. */
export interface JobCounter {
  getJobCounts(...types: ("waiting" | "delayed" | "active")[]): Promise<Record<string, number>>;
}

export function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: decodeURIComponent(url.password) || undefined,
    // BullMQ workers block on Redis; they must retry forever rather than fail a command.
    maxRetriesPerRequest: null,
  };
}
