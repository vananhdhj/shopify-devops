// Ids fixed by the seed data (db/seed/catalog.sql); tests use them as known-good expectations.
export const seedProducts = {
  lastLantern: "00000000-0000-4000-8000-000000000011",
  enamelMug: "00000000-0000-4000-8000-000000000002",
} as const;

export const unknownProductId = "00000000-0000-4000-8000-0000000000ff";
