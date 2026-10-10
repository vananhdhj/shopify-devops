import { describe, expect, it } from "vitest";

// Deliberately failing: proves a red test blocks merging into main. Never merged.
describe("branch protection drill", () => {
  it("fails on purpose", () => {
    expect(1 + 1).toBe(3);
  });
});
