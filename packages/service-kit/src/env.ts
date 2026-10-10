/** Reads a required environment variable, failing fast at startup when it is missing. */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}
