import { describe, expect, it } from "vitest";
import type { Brand, Segment } from "shared";
import { checkOption, cutAfterLine, freeIntervals, mergeSilences, renderLines } from "../src/stages/placement";

const seg = (start: number, end: number, text = "x"): Segment => ({ id: 0, start, end, text, chunkIndex: 0, source: "llm" });

describe("mergeSilences", () => {
  it("joins touching pieces", () => {
    expect(mergeSilences([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 2.02, end: 3 }])).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
  });
});

describe("renderLines", () => {
  it("numbers dialogue lines and puts silence and shot-cut markers where they happen, unnumbered", () => {
    const text = renderLines([seg(10, 11, "a"), seg(14, 15, "b")], "", { silences: [{ start: 11.2, end: 13 }, { start: 16, end: 16.1 }], shotCuts: [12.5] }, { from: 10, to: 20, showSilenceMinSec: 0.5 });
    expect(text.split("\n")).toEqual(["1. [10.0–11.0] a", "    · silence 1.8s [11.2–13.0]", "    · shot cut [12.5]", "2. [14.0–15.0] b"]);
  });
});

describe("cutAfterLine", () => {
  const o = { minSpeechFreeSec: 1.5, padSec: 0.15, durationSec: 1000 };
  it("cuts inside a measured silence, on a shot cut if one falls there", () => {
    const r = cutAfterLine(seg(10, 11), seg(15, 16), { silences: [{ start: 11.2, end: 13 }], shotCuts: [12.5], speech: [] }, o);
    expect(r).toMatchObject({ cutTime: 12.5, basis: "silence" });
  });
  it("uses a speech-free pause (music) when there is no silence", () => {
    const r = cutAfterLine(seg(10, 11), seg(15, 16), { silences: [], shotCuts: [], speech: [] }, o);
    expect(r).toMatchObject({ cutTime: 13, basis: "speechFree" });
  });
  it("refuses a pause shorter than minSpeechFreeSec when there is no silence in it", () => {
    const r = cutAfterLine(seg(10, 11), seg(11.5, 12), { silences: [], shotCuts: [11.4], speech: [] }, o);
    expect(r.cutTime).toBeUndefined();
    expect(r.reason).toMatch(/only 0.5s/);
  });
  it("uses a silence of any length inside the gap", () => {
    const r = cutAfterLine(seg(10, 11), seg(12, 13), { silences: [{ start: 10.7, end: 11.6 }], shotCuts: [], speech: [] }, o);
    expect(r).toMatchObject({ cutTime: 11.3, basis: "silence" });
  });
  it("refuses a pause filled with transcribed words", () => {
    const words = [{ start: 11.5, end: 12.4 }, { start: 13.2, end: 14.3 }];
    expect(cutAfterLine(seg(10, 11), seg(15, 16), { silences: [], shotCuts: [], speech: words }, o).cutTime).toBeUndefined();
  });
  it("takes the earliest word-free stretch of the pause, not just its middle", () => {
    // Real case (indubala 5:48): words start 0.6 s after the line, then a 1.8 s free stretch, then a song.
    const words = [{ start: 348.87, end: 349.87 }, { start: 351.67, end: 358 }]; // free stretch is exactly 1.5 s after padding
    const r = cutAfterLine(seg(346.9, 348.3), seg(360, 366), { silences: [], shotCuts: [], speech: words }, o);
    expect(r.basis).toBe("speechFree");
    expect(r.cutTime).toBeCloseTo(350.77, 1);
  });
});

const brand = (id: string, negative: string[]): Brand => ({ id, name: id.toUpperCase(), category: "", targetContexts: [], negativeContexts: negative, creatives: [] });
describe("freeIntervals", () => {
  it("returns the parts of a span with no (padded) word", () => {
    expect(freeIntervals({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 6, end: 7 }], 0.5)).toEqual([
      { start: 0, end: 1.5 },
      { start: 3.5, end: 5.5 },
      { start: 7.5, end: 10 },
    ]);
  });
});

describe("checkOption", () => {
  const brands = [brand("brand_a", ["funeral"]), brand("brand_b", ["eating"])];
  const base = { brands, blockAll: ["violence"], contextsNearby: [] as string[], minBrandFit: 0.3 };
  it("passes a clean option", () => {
    expect(checkOption({ brandId: "brand_a", fit: 0.9 }, base)).toEqual([]);
  });
  it("rejects the previous brand, reported contexts, block-all contexts and low fit", () => {
    const p = checkOption({ brandId: "brand_a", fit: 0.2 }, { ...base, previousBrand: "brand_a", contextsNearby: ["funeral", "violence"] });
    expect(p.join(" | ")).toMatch(/previous break/);
    expect(p.join(" | ")).toMatch(/funeral/);
    expect(p.join(" | ")).toMatch(/blocks every brand/);
    expect(p.join(" | ")).toMatch(/fit 0.20/);
  });
  it("rejects a brand reporting its own negative context, and an unknown brand", () => {
    expect(checkOption({ brandId: "brand_b", fit: 0.9 }, { ...base, contextsNearby: ["Eating "] })[0]).toMatch(/eating/);
    expect(checkOption({ brandId: "nope", fit: 0.9 }, base)).toEqual(["unknown brand nope"]);
  });
});
