// HARD RULES: negative contexts block; when unsure, don't place.
import { describe, expect, it } from "vitest";
import { decideEligibility } from "../src/stages/match/eligibility";
import { T, brand, scene, tag } from "./fixtures";

const brands = [brand("food", ["funeral", "bathroom"]), brand("care", ["funeral", "eating"])];

describe("decideEligibility", () => {
  it("blocks a brand when its negative context is tagged on the scene before", () => {
    const d = decideEligibility(brands, scene(0, { negativeTags: [tag("eating")] }), scene(1), T);
    expect(d.find((x) => x.brandId === "care")?.eligible).toBe(false);
    expect(d.find((x) => x.brandId === "food")?.eligible).toBe(true);
  });

  it("blocks a brand when its negative context is tagged on the scene after", () => {
    const d = decideEligibility(brands, scene(0), scene(1, { negativeTags: [tag("bathroom")] }), T);
    expect(d.find((x) => x.brandId === "food")?.blockedBy?.[0]).toMatchObject({ context: "bathroom", scene: "after" });
  });

  it("blocks at low tag confidence (cautious), ignores tags below the threshold", () => {
    const low = T.negativeTagMinConfidence;
    expect(decideEligibility(brands, scene(0, { negativeTags: [tag("funeral", low)] }), scene(1), T).every((d) => !d.eligible)).toBe(true);
    expect(decideEligibility(brands, scene(0, { negativeTags: [tag("funeral", low - 0.01)] }), scene(1), T).every((d) => d.eligible)).toBe(true);
  });

  it("makes no brand eligible when either scene is low-confidence", () => {
    const unsure = scene(1, { confidence: T.sceneMinConfidence - 0.01 });
    const d = decideEligibility(brands, scene(0), unsure, T);
    expect(d.every((x) => !x.eligible && x.unclassified)).toBe(true);
  });
});
