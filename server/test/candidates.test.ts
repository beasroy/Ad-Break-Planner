// HARD RULE: no cut while anyone is speaking.
import { describe, expect, it } from "vitest";
import { computeCandidates, findSafeInterval, subtract } from "../src/stages/candidates";
import { SCORING, T, scene, seg } from "./fixtures";

const inside = (t: number, a: number, b: number) => t >= a && t <= b;

describe("subtract", () => {
  it("removes every hole from the outer interval", () => {
    expect(subtract({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 5, end: 12 }])).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe("findSafeInterval", () => {
  const gap = { start: 10, end: 14 };

  it("puts the cut inside a silence window, padded away from speech", () => {
    const r = findSafeInterval(gap, [seg(0, 5, 10), seg(1, 14, 18)], [{ start: 10.5, end: 13 }], [], 700, T);
    expect(r.confirmed).toBe(true);
    expect(r.safe!.start).toBeGreaterThanOrEqual(10 + T.cutPaddingMs / 1000);
    expect(r.safe!.end).toBeLessThanOrEqual(14 - T.cutPaddingMs / 1000);
    expect(inside(r.safe!.start, 10.5, 13) && inside(r.safe!.end, 10.5, 13)).toBe(true);
  });

  it("treats hallucination-flagged segments as speech", () => {
    const dropped = seg(2, 10.2, 13.8, { dropped: { reason: "test" } });
    const r = findSafeInterval(gap, [seg(0, 5, 10), dropped, seg(1, 14, 18)], [{ start: 10, end: 14 }], [], 700, T);
    expect(r.safe).toBeUndefined();
  });

  it("rejects silence shorter than minSilenceMs", () => {
    const r = findSafeInterval(gap, [], [{ start: 11, end: 11.4 }], [], 700, T);
    expect(r.safe).toBeUndefined();
  });

  it("never cuts without measured silence when confirmation is required (default)", () => {
    expect(T.requireSilenceConfirmation).toBe(true);
    const r = findSafeInterval({ start: 100, end: 110 }, [], [], [], 700, T);
    expect(r.safe).toBeUndefined();
    expect(r.reason).toMatch(/no measured silence/);
  });

  it("if confirmation is turned off, allows an unconfirmed gap only when long and away from chunk seams", () => {
    const loose = { ...T, requireSilenceConfirmation: false };
    const long = { start: 100, end: 103 };
    expect(findSafeInterval(long, [], [], [], 700, loose).safe).toBeDefined();
    expect(findSafeInterval(long, [], [], [101.5], 700, loose).safe).toBeUndefined();
    expect(findSafeInterval({ start: 100, end: 101.5 }, [], [], [], 700, loose).safe).toBeUndefined();
  });
});

describe("±boundarySearchSec search around the estimated scene change", () => {
  // Scene A "ends" at 20, scene B "starts" at 21 according to LLM timestamps.
  const estimate = { start: 20, end: 21 };
  const llm = (id: number, a: number, b: number) => seg(id, a, b, { approxTiming: true });

  it("finds the real pause the LLM misplaced (under its own drifted timestamps)", () => {
    const r = findSafeInterval(estimate, [llm(0, 10, 20), llm(1, 21, 30)], [{ start: 22.5, end: 23.8 }], [], 700, T);
    expect(r.confirmed).toBe(true);
    expect(r.safe!.start).toBeCloseTo(22.5 + T.cutPaddingMs / 1000);
    expect(r.safe!.end).toBeCloseTo(23.8 - T.cutPaddingMs / 1000);
  });

  it("does not look further than boundarySearchSec away", () => {
    const far = 21 + T.boundarySearchSec + 0.5;
    const r = findSafeInterval(estimate, [llm(0, 10, 20), llm(1, 21, 30)], [{ start: far, end: far + 2 }], [], 700, T);
    expect(r.safe).toBeUndefined();
  });

  it("still never cuts through audio-aligned (Whisper) speech, even inside silence", () => {
    const whisper = seg(1, 22, 24);
    const r = findSafeInterval(estimate, [whisper], [{ start: 22.5, end: 23.8 }], [], 700, T);
    expect(r.safe).toBeUndefined();
  });

  it("applies minSilenceMs to the measured silence, then pads the cut region inside it", () => {
    const r = findSafeInterval(estimate, [], [{ start: 22, end: 22.8 }], [], 700, T); // 800ms silence
    expect(r.safe!.start).toBeCloseTo(22 + T.cutPaddingMs / 1000);
    expect(r.safe!.end).toBeCloseTo(22.8 - T.cutPaddingMs / 1000);
  });

  it("prefers the longest pause in the window", () => {
    const r = findSafeInterval(estimate, [], [{ start: 20.2, end: 21.2 }, { start: 22, end: 23.8 }], [], 700, T);
    expect(r.safe!.start).toBeCloseTo(22 + T.cutPaddingMs / 1000);
  });
});

describe("computeCandidates", () => {
  const segments = [seg(0, 0, 10), seg(1, 10.2, 20), seg(2, 23, 30), seg(3, 30.1, 40)];
  const scenes = [
    scene(0, { firstSegmentId: 0, lastSegmentId: 1, start: 0, end: 20 }),
    scene(1, { firstSegmentId: 2, lastSegmentId: 3, start: 23, end: 40 }),
  ];

  it("snaps to a shot cut inside the safe interval, and never into speech", () => {
    const [c] = computeCandidates({
      scenes,
      segments,
      chunkSeams: [],
      signals: { silences: [{ start: 20.1, end: 22.9 }], shotCuts: [15, 21.7, 25] },
      minSilenceMs: 700,
      thresholds: T,
      scoring: SCORING,
    });
    expect(c.rejected).toBeUndefined();
    expect(c.cutTime).toBe(21.7);
    expect(c.snappedTo).toBe("shotCut");
    for (const s of segments) expect(inside(c.cutTime!, s.start, s.end)).toBe(false);
  });

  it("uses the silence midpoint when no shot cut is available", () => {
    const [c] = computeCandidates({
      scenes,
      segments,
      chunkSeams: [],
      signals: { silences: [{ start: 20.5, end: 22.5 }], shotCuts: [] },
      minSilenceMs: 700,
      thresholds: T,
      scoring: SCORING,
    });
    expect(c.cutTime).toBeCloseTo(21.5);
    expect(c.snappedTo).toBe("silenceMidpoint");
  });

  it("rejects boundaries where speech overlaps", () => {
    const overlapping = [scenes[0], { ...scenes[1], start: 19 }];
    const [c] = computeCandidates({
      scenes: overlapping,
      segments,
      chunkSeams: [],
      signals: { silences: [], shotCuts: [] },
      minSilenceMs: 700,
      thresholds: T,
      scoring: SCORING,
    });
    expect(c.rejected?.stage).toBe("candidates");
    expect(c.cutTime).toBeUndefined();
  });
});
