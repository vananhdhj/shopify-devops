// Ids fixed by the seed data (db/seed/catalog.sql); tests use them as known-good expectations.
// Harbor Goods' seed catalog (the first seeded shop, and the one tests use by default).
export const seedProducts = {
  canvasTote: "00000000-0000-4000-8000-000000000001",
  linenApron: "00000000-0000-4000-8000-000000000003",
  beeswaxCandle: "00000000-0000-4000-8000-000000000004",
  ceramicPlanter: "00000000-0000-4000-8000-000000000005",
  brassOpener: "00000000-0000-4000-8000-000000000008",
  oliveWoodBoard: "00000000-0000-4000-8000-000000000009",
  cottonThrow: "00000000-0000-4000-8000-000000000010",
  finalPrint: "00000000-0000-4000-8000-000000000012",
  lastLantern: "00000000-0000-4000-8000-000000000011",
  enamelMug: "00000000-0000-4000-8000-000000000002",
  woolSocks: "00000000-0000-4000-8000-000000000006",
  notebookSet: "00000000-0000-4000-8000-000000000007",
} as const;

export const unknownProductId = "00000000-0000-4000-8000-0000000000ff";

// Meadow Supply's seed catalog (the second seeded shop).
export const meadowProducts = {
  seedPacketTrio: "00000000-0000-4000-8000-000000000101",
  handTrowel: "00000000-0000-4000-8000-000000000102",
  wateringCan: "00000000-0000-4000-8000-000000000103",
  gardenTwine: "00000000-0000-4000-8000-000000000104",
  heirloomSundial: "00000000-0000-4000-8000-000000000105",
} as const;
