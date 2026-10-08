import type { Brand, Segment } from "shared";
import { config } from "../src/config";

export const SCORING = config.scoring;

export const seg = (id: number, start: number, end: number, extra: Partial<Segment> = {}): Segment => ({
  id,
  start,
  end,
  text: `line ${id}`,
  chunkIndex: 0,
  source: "scribe",
  ...extra,
});

export const brand = (id: string, negativeContexts: string[], durations = [15, 20, 30], targetContexts: string[] = []): Brand => ({
  id,
  name: `Synth ${id}`,
  category: "test",
  targetContexts,
  negativeContexts,
  creatives: durations.map((d) => ({ id: `${id}_${d}`, durationSec: d, language: "bn", file: `/tmp/${id}_${d}.mp4` })),
});
