// Stage 5 ("Where"): a candidate per scene boundary. HARD RULE enforced here:
// the cut time must sit in a speech-free interval, padded away from every
// segment edge (including segments flagged as hallucinations), and confirmed
// by an ffmpeg silence window unless the gap is long and away from chunk seams.
import type { Candidate, Interval, Scene, ScoreWeights, Segment, Signals, Thresholds, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { artifactPath, type StageContext } from "./context";

const len = (i: Interval) => i.end - i.start;

/** Pure: `outer` minus the union of `holes`. */
export function subtract(outer: Interval, holes: Interval[]): Interval[] {
  let free: Interval[] = [outer];
  for (const h of holes) {
    free = free.flatMap((f) => {
      if (h.end <= f.start || h.start >= f.end) return [f];
      const parts: Interval[] = [];
      if (h.start > f.start) parts.push({ start: f.start, end: h.start });
      if (h.end < f.end) parts.push({ start: h.end, end: f.end });
      return parts;
    });
  }
  return free.filter((f) => len(f) > 0);
}

export function intersect(a: Interval, bs: Interval[]): Interval[] {
  return bs
    .map((b) => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) }))
    .filter((i) => len(i) > 0);
}

const longest = (xs: Interval[]) => xs.reduce<Interval | undefined>((m, x) => (!m || len(x) > len(m) ? x : m), undefined);

export interface CandidateInputs {
  scenes: Scene[];
  segments: Segment[];
  chunkSeams: number[];
  signals: Signals;
  minSilenceMs: number;
  thresholds: Thresholds;
  scoring: ScoreWeights;
}

export function findSafeInterval(
  gap: Interval,
  segments: Segment[],
  silences: Interval[],
  chunkSeams: number[],
  minSilenceMs: number,
  t: Thresholds,
): { safe?: Interval; confirmed: boolean; reason?: string } {
  const pad = t.cutPaddingMs / 1000;
  // Every segment, kept or dropped, counts as occupied time.
  const free = subtract(gap, segments)
    .map((f) => ({ start: f.start + pad, end: f.end - pad }))
    .filter((f) => len(f) > 0);
  if (!free.length) return { confirmed: false, reason: "no speech-free time after padding" };

  const confirmed = longest(free.flatMap((f) => intersect(f, silences)));
  if (confirmed && len(confirmed) * 1000 >= minSilenceMs) return { safe: confirmed, confirmed: true };

  const guard = t.chunkSeamGuardMs / 1000;
  const unconfirmed = longest(
    free.filter((f) => !chunkSeams.some((s) => s > f.start - guard && s < f.end + guard)),
  );
  if (unconfirmed && len(unconfirmed) * 1000 >= t.minGapWithoutSilenceMs) return { safe: unconfirmed, confirmed: false };

  const best = longest(free)!;
  return {
    confirmed: false,
    reason: `speech-free gap too short (${Math.round(len(best) * 1000)}ms free, ${Math.round(
      (confirmed ? len(confirmed) : 0) * 1000,
    )}ms silence-confirmed; need ${minSilenceMs}ms confirmed or ${t.minGapWithoutSilenceMs}ms unconfirmed away from chunk seams)`,
  };
}

/** Pure: build and score every scene-boundary candidate. */
export function computeCandidates(inp: CandidateInputs): Candidate[] {
  const { scenes, segments, signals, scoring } = inp;
  const out: Candidate[] = [];

  for (let k = 0; k < scenes.length - 1; k++) {
    const a = scenes[k];
    const b = scenes[k + 1];
    const c: Candidate = { id: `c${a.id}-${b.id}`, sceneBeforeId: a.id, sceneAfterId: b.id, gap: { start: a.end, end: b.start } };
    out.push(c);

    if (b.start <= a.end) {
      c.rejected = { stage: "candidates", reason: "speech overlaps across the scene boundary" };
      continue;
    }
    const r = findSafeInterval(c.gap, segments, signals.silences, inp.chunkSeams, inp.minSilenceMs, inp.thresholds);
    if (!r.safe) {
      c.rejected = { stage: "candidates", reason: r.reason! };
      continue;
    }
    c.safe = r.safe;

    const mid = (r.safe.start + r.safe.end) / 2;
    const shots = signals.shotCuts.filter((t) => t >= r.safe!.start && t <= r.safe!.end);
    if (shots.length) {
      c.cutTime = shots.reduce((best, t) => (Math.abs(t - mid) < Math.abs(best - mid) ? t : best));
      c.snappedTo = "shotCut";
    } else {
      c.cutTime = mid;
      c.snappedTo = r.confirmed ? "silenceMidpoint" : "gapMidpoint";
    }

    const w = scoring.where;
    const parts = {
      gap: Math.min(1, len(r.safe) / scoring.gapSaturationSec),
      shotCut: shots.length ? 1 : 0,
      closure: a.closure,
      calm: 1 - a.tension,
    };
    c.where = {
      ...parts,
      total: parts.gap * w.gap + parts.shotCut * w.shotCut + parts.closure * w.closure + parts.calm * w.calm,
    };
  }
  return out;
}

export async function runCandidates(ctx: StageContext, scenes: Scene[], transcript: Transcript, signals: Signals) {
  const out = artifactPath(ctx, ARTIFACTS.candidates);
  const inputs = {
    minSilenceMs: ctx.config.pacing.minSilenceMs,
    thresholds: ctx.config.thresholds,
    scoring: ctx.config.scoring,
  };
  const key = hashJson({ inputs, scenes: hashJson(scenes) });
  const cached = ctx.force ? undefined : await readKeyed<Candidate[]>(out, key);
  if (cached) return cached;

  const candidates = computeCandidates({
    scenes,
    segments: transcript.segments,
    chunkSeams: transcript.chunkSeams,
    signals,
    ...inputs,
  });
  await writeKeyed(out, key, candidates);
  const ok = candidates.filter((c) => !c.rejected).length;
  ctx.log(`candidates: ${candidates.length} boundaries, ${ok} pass the Where check`);
  return candidates;
}
