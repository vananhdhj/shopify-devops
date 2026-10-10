/** Rejects with `message` if `work` hasn't settled within `ms`; the timer never keeps the process alive. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref()),
  ]);
}
