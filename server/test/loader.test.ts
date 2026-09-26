import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { loadCatalogue, parseCatalogue } from "../src/catalogue/loader";

const brand = (id: string, negative: string[]) => ({
  brand_id: id,
  display_name: `Synth ${id}`,
  category: "test",
  target_contexts: ["cooking"],
  negative_contexts: negative,
  creatives: [{ id: `${id}_15`, duration_sec: 15, language: "bn", url: `ads/${id}/${id}_15.mp4` }],
});

describe("catalogue loader", () => {
  it("loads the organiser catalogue and builds the negative vocab at runtime", async () => {
    const cat = await loadCatalogue(config.cataloguePath);
    expect(cat.brands).toHaveLength(8);
    expect(cat.negativeVocab).toEqual([...new Set(cat.brands.flatMap((b) => b.negativeContexts))].sort());
    expect(cat.brands[0].creatives.length).toBeGreaterThan(0);
  });

  it("picks up an unseen brand and its new negative contexts with no code change", () => {
    const cat = parseCatalogue([brand("brand_zz", ["Flood ", "grief"])], "/tmp/cat");
    expect(cat.brands[0].negativeContexts).toEqual(["flood", "grief"]);
    expect(cat.negativeVocab).toContain("flood");
    expect(cat.brands[0].creatives[0].file).toBe("/tmp/cat/ads/brand_zz/brand_zz_15.mp4");
  });

  it("rejects duplicate ids and malformed entries", () => {
    const b = brand("x", []);
    expect(() => parseCatalogue([b, b], "/tmp")).toThrow(/Duplicate/);
    expect(() => parseCatalogue([{ brand_id: "y" }], "/tmp")).toThrow();
  });
});
