function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4001),
  databaseUrl: required("DATABASE_URL"),
  environment: process.env.APP_ENV ?? "dev",
};
