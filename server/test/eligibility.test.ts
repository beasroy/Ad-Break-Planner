// HARD RULES: negative contexts block; when unsure, don't place.
import { describe, expect, it } from "vitest";
import { consensusContexts, decideEligibility } from "../src/stages/match/eligibility";
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

  it("consensus: a context most brands list as negative blocks every brand, even one that omits it", () => {
    // grief is on 3 of 4 lists (> 50%); "telecom" doesn't list it but is blocked anyway.
    const cat = [brand("a", ["grief"]), brand("b", ["grief"]), brand("c", ["grief", "bathroom"]), brand("telecom", ["violence"])];
    expect([...consensusContexts(cat, T.consensusNegativeShare)]).toEqual(["grief"]);
    const d = decideEligibility(cat, scene(0, { negativeTags: [tag("grief", 0.72)] }), scene(1), T);
    expect(d.every((x) => !x.eligible)).toBe(true);
    expect(d.find((x) => x.brandId === "telecom")?.blockedBy?.[0]).toMatchObject({ context: "grief", rule: "consensus" });
    expect(d.find((x) => x.brandId === "a")?.blockedBy?.[0]).toMatchObject({ rule: "brand" });
  });

  it("consensus: a minority context only blocks the brands that list it", () => {
    const cat = [brand("a", ["grief"]), brand("b", ["grief"]), brand("c", ["grief", "bathroom"]), brand("telecom", ["violence"])];
    const d = decideEligibility(cat, scene(0, { negativeTags: [tag("bathroom")] }), scene(1), T);
    expect(d.filter((x) => x.eligible).map((x) => x.brandId)).toEqual(["a", "b", "telecom"]);
  });
});
