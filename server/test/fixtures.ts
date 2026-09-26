import type { Brand, NegativeTag, Scene, Segment } from "shared";
import { config } from "../src/config";

export const T = config.thresholds;
export const PACING = config.pacing;
export const SCORING = config.scoring;

export const seg = (id: number, start: number, end: number, extra: Partial<Segment> = {}): Segment => ({
  id,
  start,
  end,
  text: `line ${id}`,
  chunkIndex: 0,
  ...extra,
});

export const scene = (id: number, over: Partial<Scene> = {}): Scene => ({
  id,
  firstSegmentId: 0,
  lastSegmentId: 0,
  start: 0,
  end: 0,
  summary: `scene ${id}`,
  activity: "talking",
  mood: "calm",
  closure: 0.8,
  tension: 0.2,
  confidence: 0.9,
  negativeTags: [],
  ...over,
});

export const tag = (context: string, confidence = 0.9): NegativeTag => ({ context, confidence, source: "transcript" });

export const brand = (id: string, negativeContexts: string[], durations = [15, 20, 30], targetContexts: string[] = []): Brand => ({
  id,
  name: `Synth ${id}`,
  category: "test",
  targetContexts,
  negativeContexts,
  creatives: durations.map((d) => ({ id: `${id}_${d}`, durationSec: d, language: "bn", file: `/tmp/${id}_${d}.mp4` })),
});
