// A 9th, unseen brand added to the real catalogue file works with zero code changes:
// its new negative context enters the vocab and the placement schema's enum, it blocks the brand
// when the model reports that context nearby, and the brand can win a break when it fits.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { parseCatalogue } from "../src/catalogue/loader";
import { placementJsonSchema } from "../src/prompts/placement";
import { checkOption, scheduleBreaks, type ScheduleItem } from "../src/stages/placement";
import { SCORING } from "./fixtures";

const NINTH = {
  brand_id: "brand_ninth",
  display_name: "Synth Ninth Paints",
  category: "home/paint",
  target_contexts: ["painting walls", "new house", "renovation"],
  negative_contexts: ["flood", "grief"],
  creatives: [{ id: "n_20s_bn", duration_sec: 20, language: "bn", url: "ads/brand_ninth/n_20s_bn.mp4" }],
};

async function catalogueWithNinth() {
  const raw = JSON.parse(await fs.readFile(config.cataloguePath, "utf8"));
  return parseCatalogue([...raw, NINTH], "/tmp/cat");
}

const item = (chunk: number, brandId: string, over: Partial<ScheduleItem> = {}): ScheduleItem => ({
  chunk,
  lineId: 1,
  brandId,
  fit: 0.9,
  reason: "fits",
  cutTime: chunk * 120,
  basis: "silence",
  pauseSec: 3,
  ...over,
});

describe("9th brand, no code change", () => {
  it("adds its negative contexts to the runtime vocab and the LLM schema enum", async () => {
    const cat = await catalogueWithNinth();
    expect(cat.brands).toHaveLength(9);
    expect(cat.negativeVocab).toContain("flood");
    const schema: any = placementJsonSchema({ lineCount: 3, brandIds: cat.brands.map((b) => b.id), contexts: cat.negativeVocab });
    const choice = schema.properties.placement.anyOf[0];
    expect(choice.properties.contexts_nearby.items.enum).toContain("flood");
    expect(choice.properties.brand_id.enum).toContain("brand_ninth");
  });

  it("is blocked by its own negative context, and otherwise schedulable", async () => {
    const cat = await catalogueWithNinth();
    const d = { brands: cat.brands, blockAll: [], minBrandFit: config.placement.minBrandFit };
    expect(checkOption({ brandId: "brand_ninth", fit: 0.9 }, { ...d, contextsNearby: ["flood"] })).toEqual([
      "model reported flood nearby, which Synth Ninth Paints must never be next to",
    ]);
    expect(checkOption({ brandId: "brand_ninth", fit: 0.9 }, { ...d, contextsNearby: ["new house"] })).toEqual([]);
  });

  it("wins a break and brings its own creative", async () => {
    const cat = await catalogueWithNinth();
    const { picks } = scheduleBreaks({
      itemsByChunk: [[item(1, "brand_ninth")], [item(2, cat.brands[0].id, { fit: 0.75 })]],
      brands: cat.brands,
      durationSec: 2700,
      maxAdLoadPct: config.placement.maxAdLoadPct,
      weights: SCORING,
      language: "bn",
      repeatPenalty: config.placement.brandRepeatPenalty,
      maxBrandRepeats: 2,
    });
    const ninth = picks.find((p) => p.item.brandId === "brand_ninth");
    expect(ninth?.creative.id).toBe("n_20s_bn");
  });
});

describe("minimum brand fit", () => {
  it("rejects an option the model scored below the fit floor", async () => {
    const cat = await catalogueWithNinth();
    const problems = checkOption(
      { brandId: "brand_ninth", fit: 0.4 },
      { brands: cat.brands, blockAll: [], contextsNearby: [], minBrandFit: config.placement.minBrandFit },
    );
    expect(problems).toEqual([`fit 0.40 below ${config.placement.minBrandFit}`]);
  });
});
