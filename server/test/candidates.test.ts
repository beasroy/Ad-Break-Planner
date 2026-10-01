// HARD RULE: no cut while anyone is speaking.
import { describe, expect, it } from "vitest";
import { applyRecheck, computeCandidates, findSafeInterval, subtract } from "../src/stages/candidates";
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
  // The scene boundary is an estimate; the transcript's own word timings are audio-aligned.
  const estimate = { start: 20, end: 21 };
  const around = [seg(0, 10, 20), seg(1, 24, 30)];

  it("finds the real pause near the estimate, just outside it", () => {
    const r = findSafeInterval(estimate, around, [{ start: 22.5, end: 23.8 }], [], 700, T);
    expect(r.confirmed).toBe(true);
    expect(r.safe!.start).toBeCloseTo(22.5 + T.cutPaddingMs / 1000);
    expect(r.safe!.end).toBeCloseTo(23.8 - T.cutPaddingMs / 1000);
  });

  it("does not look further than boundarySearchSec away", () => {
    const far = 21 + T.boundarySearchSec + 0.5;
    const r = findSafeInterval(estimate, [seg(0, 10, 20)], [{ start: far, end: far + 2 }], [], 700, T);
    expect(r.safe).toBeUndefined();
  });

  it("still never cuts through speech, even inside silence", () => {
    const spoken = seg(1, 22, 24);
    const r = findSafeInterval(estimate, [spoken], [{ start: 22.5, end: 23.8 }], [], 700, T);
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

describe("speech-free cuts (nothing transcribed and no measured silence, e.g. music)", () => {
  // A ends at 20, B starts at 23. Nothing transcribed between them, but no silence was measured.
  const estimate = { start: 20, end: 23 };
  const around = [seg(0, 10, 20), seg(1, 23, 33)];
  const cover = [{ start: 0, end: 120 }];

  it("allows a cut when nothing is transcribed for >= minSpeechFreeSec", () => {
    const r = findSafeInterval(estimate, around, [], [], 700, T, cover);
    expect(r).toMatchObject({ basis: "speechFree", confirmed: false });
    expect(r.safe!.start).toBeCloseTo(20 + T.cutPaddingMs / 1000);
    expect(r.safe!.end).toBeCloseTo(23 - T.cutPaddingMs / 1000);
  });

  it("a single word inside the gap breaks it up", () => {
    const r = findSafeInterval(estimate, [...around, seg(2, 21.2, 21.6)], [], [], 700, T, cover);
    expect(r.safe).toBeUndefined();
  });

  it("is never used where the transcriber did not cover the audio", () => {
    expect(findSafeInterval(estimate, around, [], [], 700, T, []).safe).toBeUndefined();
    expect(findSafeInterval(estimate, around, [], [], 700, T, [{ start: 60, end: 120 }]).safe).toBeUndefined();
  });

  it("is not used across a transcription chunk seam", () => {
    expect(findSafeInterval(estimate, around, [], [21.5], 700, T, cover).safe).toBeUndefined();
  });

  it("prefers measured silence when there is one", () => {
    const r = findSafeInterval(estimate, around, [{ start: 20.5, end: 21.4 }], [], 700, T, cover);
    expect(r.basis).toBe("silence");
  });

  it("scores speech-free gaps below equal silent gaps", () => {
    const scenes = [scene(0, { start: 10, end: 20 }), scene(1, { start: 23, end: 33 })];
    const base = { scenes, segments: around, speech: [], chunkSeams: [], minSilenceMs: 700, thresholds: T, scoring: SCORING };
    const music = computeCandidates({ ...base, speechCoverage: cover, signals: { silences: [], shotCuts: [] } })[0];
    const quiet = computeCandidates({ ...base, speechCoverage: cover, signals: { silences: [{ start: 20, end: 23 }], shotCuts: [] } })[0];
    expect(music.cutBasis).toBe("speechFree");
    expect(quiet.cutBasis).toBe("silence");
    expect(music.where!.gap).toBeLessThan(quiet.where!.gap);
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
      speech: [],
      speechCoverage: [],
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
      speech: [],
      speechCoverage: [],
      chunkSeams: [],
      signals: { silences: [{ start: 20.5, end: 22.5 }], shotCuts: [] },
      minSilenceMs: 700,
      thresholds: T,
      scoring: SCORING,
    });
    expect(c.cutTime).toBeCloseTo(21.5);
    expect(c.snappedTo).toBe("silenceMidpoint");
  });

  it("speech intervals block a cut the text segments alone would allow (e.g. an audio event)", () => {
    const text = [seg(0, 0, 20), seg(1, 23, 40)];
    const base = {
      scenes,
      segments: text,
      chunkSeams: [],
      signals: { silences: [{ start: 20.5, end: 22.5 }], shotCuts: [] },
      minSilenceMs: 700,
      thresholds: T,
      scoring: SCORING,
    };
    expect(computeCandidates({ ...base, speech: [], speechCoverage: [] })[0].cutTime).toBeDefined();
    // A word or a named sound (music, crying) runs through the quiet window: no cut.
    expect(computeCandidates({ ...base, speech: [{ start: 20, end: 23 }], speechCoverage: [] })[0].rejected?.stage).toBe("candidates");
  });

  it("rejects boundaries where speech overlaps", () => {
    const overlapping = [scenes[0], { ...scenes[1], start: 19 }];
    const [c] = computeCandidates({
      scenes: overlapping,
      segments,
      speech: [],
      speechCoverage: [],
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

describe("applyRecheck (independent re-listen of the cut window)", () => {
  const safe = { start: 100, end: 110 };

  it("keeps the window when the re-listen hears nothing", () => {
    expect(applyRecheck(safe, [], 0.5, 105)).toEqual(safe);
  });

  it("moves away from a word heard near the cut, keeping the padding", () => {
    const kept = applyRecheck(safe, [{ start: 104.5, end: 104.9 }], 0.5, 105)!;
    expect(kept.start).toBeCloseTo(105.4);
    expect(kept.end).toBe(110);
  });

  it("returns nothing when the re-listen hears speech throughout", () => {
    const words = [100, 101.5, 103, 104.5, 106, 107.5, 109].map((t) => ({ start: t, end: t + 0.9 }));
    expect(applyRecheck(safe, words, 0.5, 105)).toBeUndefined();
  });
});
