// Probe and scrape routes are hit every few seconds; logging each one would bury real traffic.
export const quietRoute = { logLevel: "warn" } as const;
