// HARD RULE: pacing limits; plus no back-to-back same brand.
import { describe, expect, it } from "vitest";
import type { MatchedCandidate } from "shared";
import { pickCreative, selectBreaks } from "../src/stages/select";
import { PACING, SCORING, brand } from "./fixtures";

const cand = (id: string, t: number, where: number, ranked: [string, number][]): MatchedCandidate => ({
  id,
  sceneBeforeId: 0,
  sceneAfterId: 1,
  gap: { start: t - 1, end: t + 1 },
  cutTime: t,
  where: { gap: 1, shotCut: 1, closure: 1, calm: 1, total: where },
  brands: [],
  ranked: ranked.map(([brandId, fit]) => ({ brandId, fit, reason: `fits ${brandId}` })),
});

const brands = [brand("a", []), brand("b", []), brand("c", [], [20, 30])];
const run = (candidates: MatchedCandidate[], durationSec = 2700, pacing = PACING) =>
  selectBreaks({ candidates, brands, durationSec, pacing, weights: SCORING.combined, language: "bn" });

describe("selectBreaks", () => {
  it("respects no-break zones, min gap and the per-hour cap", () => {
    const cs = [
      cand("early", 60, 0.99, [["a", 1]]),
      cand("late", 2650, 0.99, [["a", 1]]),
      cand("x1", 600, 0.9, [["a", 1]]),
      cand("x1-near", 700, 0.95, [["b", 1]]),
      cand("x2", 1200, 0.8, [["b", 1]]),
      cand("x3", 1800, 0.7, [["c", 1]]),
      cand("x4", 2400, 0.6, [["a", 1]]),
    ];
    const { breaks, log } = run(cs);
    const times = breaks.map((b) => b.timeSec).sort((a, b) => a - b);
    expect(breaks.length).toBe(Math.round((PACING.maxBreaksPerHour * 2700) / 3600)); // 3
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(PACING.noBreakFirstSec);
      expect(t).toBeLessThanOrEqual(2700 - PACING.noBreakLastSec);
    }
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(PACING.minGapSec);
    expect(log.find((l) => l.candidateId === "early")?.reason).toMatch(/first/);
    expect(log.find((l) => l.candidateId === "late")?.reason).toMatch(/last/);
  });

  it("rounds the break cap to nearest: a 25.6 min episode gets 2 breaks", () => {
    const dur = 25.6 * 60; // 4/h × 0.427h = 1.7 → 2
    const { breaks } = run([cand("x1", 400, 0.9, [["a", 1]]), cand("x2", 1000, 0.8, [["b", 1]]), cand("x3", 1350, 0.7, [["c", 1]])], dur);
    expect(breaks).toHaveLength(2);
  });

  it("prefers more breaks over one higher-scoring break (feluda case)", () => {
    // Best single cut at 12.6m blocks both 6.6m and 18.8m; those two are 12 min apart.
    const { breaks } = run(
      [cand("m6.6", 396, 0.47, [["a", 0.92], ["b", 0.5]]), cand("m12.6", 756, 0.65, [["c", 0.8]]), cand("m18.8", 1128, 0.41, [["a", 1], ["b", 0.6]])],
      25.6 * 60,
    );
    expect(breaks.map((b) => b.candidateId)).toEqual(["m6.6", "m18.8"]);
    expect(breaks[0].brandId).not.toBe(breaks[1].brandId);
  });

  it("gives an earlier break its second-best brand when that lets a later break exist", () => {
    // Both prefer "a"; the later one can ONLY take "a". The earlier one must take "b".
    const { breaks } = run([cand("early", 600, 0.9, [["a", 1], ["b", 0.6]]), cand("late", 1200, 0.8, [["a", 0.9]])]);
    expect(breaks.map((b) => [b.candidateId, b.brandId])).toEqual([
      ["early", "b"],
      ["late", "a"],
    ]);
  });

  it("upgrades to longer creatives when the ad-load budget allows", () => {
    const { breaks } = run([cand("x1", 600, 0.9, [["a", 1]]), cand("x2", 1200, 0.8, [["b", 1]])]);
    expect(breaks.map((b) => b.adDurationSec)).toEqual([30, 30]);
  });

  it("never exceeds the ad-load cap", () => {
    const tight = { ...PACING, maxAdLoadPct: 40 / 2700 };
    const { breaks } = run([cand("x1", 600, 0.9, [["a", 1]]), cand("x2", 1200, 0.8, [["b", 1]]), cand("x3", 1800, 0.7, [["c", 1]])], 2700, tight);
    const total = breaks.reduce((t, b) => t + b.adDurationSec, 0);
    expect(total).toBeLessThanOrEqual(40);
  });

  it("swaps a back-to-back repeated brand to the next eligible one", () => {
    const { breaks } = run([
      cand("x1", 600, 0.9, [["a", 1], ["b", 0.5]]),
      cand("x2", 1200, 0.8, [["a", 0.9], ["b", 0.6]]),
    ]);
    expect(breaks.map((b) => b.brandId)).toEqual(["a", "b"]);
    expect(breaks[1].reason).toMatch(/back-to-back/);
  });

  it("drops a repeated brand break when there is no alternative", () => {
    const { breaks, log } = run([cand("x1", 600, 0.9, [["a", 1]]), cand("x2", 1200, 0.8, [["a", 1]])]);
    expect(breaks.map((b) => b.candidateId)).toEqual(["x1"]);
    expect(log.find((l) => l.candidateId === "x2")?.reason).toMatch(/same brand/);
  });
});

describe("pickCreative", () => {
  it("picks the longest creative that fits the budget", () => {
    expect(pickCreative(brands[0], 25, "bn")?.durationSec).toBe(20);
    expect(pickCreative(brands[2], 15, "bn")).toBeUndefined();
  });
});
