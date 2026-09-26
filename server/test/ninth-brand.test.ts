// A 9th, unseen brand added to the real catalogue file works with zero code changes:
// its new negative context enters the vocab, blocks it, and it can win a break when it fits.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Brand, Candidate, Scene } from "shared";
import { config } from "../src/config";
import { parseCatalogue } from "../src/catalogue/loader";
import { matchCandidates, type RankFn } from "../src/stages/match";
import { selectBreaks } from "../src/stages/select";
import { scenesJsonSchema } from "../src/prompts/scenes";
import { scene, tag } from "./fixtures";

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

// Stand-in for the LLM ranker: scores by overlap between the scene activity and target contexts.
const overlapRank: RankFn = async (before, _after, eligible: Brand[]) =>
  eligible.map((b) => ({
    brandId: b.id,
    fit: b.targetContexts.some((t) => before.activity.includes(t)) ? 1 : 0.1,
    reason: "overlap",
  }));

const candidate = (id: string, t: number, a: number, b: number): Candidate => ({
  id,
  sceneBeforeId: a,
  sceneAfterId: b,
  gap: { start: t - 1, end: t + 1 },
  safe: { start: t - 0.5, end: t + 0.5 },
  cutTime: t,
  where: { gap: 1, shotCut: 1, closure: 1, calm: 1, total: 0.9 },
});

describe("9th brand, no code change", () => {
  it("adds its negative contexts to the runtime vocab and the LLM schema enum", async () => {
    const cat = await catalogueWithNinth();
    expect(cat.brands).toHaveLength(9);
    expect(cat.negativeVocab).toContain("flood");
    const schema: any = scenesJsonSchema(cat.negativeVocab);
    expect(schema.properties.scenes.items.properties.negative_contexts.items.properties.context.enum).toContain("flood");
  });

  it("is chosen for a fitting scene and blocked by its own negative context", async () => {
    const cat = await catalogueWithNinth();
    const scenes: Scene[] = [
      scene(0, { activity: "painting walls of the new house" }),
      scene(1),
      scene(2, { activity: "painting walls of the new house", negativeTags: [tag("flood")] }),
      scene(3),
    ];
    const cands = [candidate("fit", 600, 0, 1), candidate("blocked", 1300, 2, 3)];
    const matched = await matchCandidates(cands, scenes, cat.brands, config.thresholds, () => overlapRank, 2);
    const { breaks } = selectBreaks({
      candidates: matched,
      brands: cat.brands,
      durationSec: 2700,
      pacing: config.pacing,
      weights: config.scoring.combined,
      language: "bn",
    });

    const fit = breaks.find((b) => b.candidateId === "fit");
    expect(fit?.brandId).toBe("brand_ninth");
    expect(fit?.creativeId).toBe("n_20s_bn");

    const blocked = matched.find((c) => c.id === "blocked") as any;
    expect(blocked.brands.find((d: any) => d.brandId === "brand_ninth")).toMatchObject({ eligible: false });
    expect(breaks.find((b) => b.candidateId === "blocked")?.brandId).not.toBe("brand_ninth");
  });
});
