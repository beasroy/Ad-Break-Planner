// Stage 5 ("Where"): a candidate per scene boundary. HARD RULE enforced here:
// the cut time must sit inside a measured ffmpeg silence window (padded), and
// outside every audio-aligned (Deepgram) segment, flagged ones included. LLM
// transcript timing drifts by seconds, so we search ±boundarySearchSec around the
// estimated scene change and let measured silence, not LLM timestamps, prove quiet.
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
  /** Audio-aligned speech intervals (Deepgram): always hard walls. */
  speech: Interval[];
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
  const lo = Math.min(gap.start, gap.end);
  const hi = Math.max(gap.start, gap.end);
  const window = { start: lo - t.boundarySearchSec, end: hi + t.boundarySearchSec };
  const centre = (lo + hi) / 2;

  // Audio-aligned segments are hard walls; LLM-timed ones are not trusted either way.
  const walls = segments.filter((s) => !s.approxTiming);
  const openTime = subtract(window, walls);

  // Measured silence inside the open time must itself be >= minSilenceMs; the cut is then
  // confined to its padded interior, away from where sound resumes.
  const quiet = openTime
    .flatMap((f) => intersect(f, silences))
    .filter((q) => len(q) * 1000 >= minSilenceMs)
    .map((q) => ({ start: q.start + pad, end: q.end - pad }));
  // Longest pause wins (real scene changes pause longest); ties go to the one nearest the estimate.
  const dist = (q: Interval) => Math.abs((q.start + q.end) / 2 - centre);
  const confirmed = quiet.sort((a, b) => len(b) - len(a) || dist(a) - dist(b))[0];
  if (confirmed) return { safe: confirmed, confirmed: true };

  if (t.requireSilenceConfirmation) {
    return {
      confirmed: false,
      reason: `no measured silence of ${minSilenceMs}ms within ±${t.boundarySearchSec}s of the scene change`,
    };
  }

  // Legacy path (only when silence confirmation is switched off): strict gap between all segments.
  if (gap.end <= gap.start) return { confirmed: false, reason: "speech overlaps across the scene boundary" };
  const free = subtract(gap, segments)
    .map((f) => ({ start: f.start + pad, end: f.end - pad }))
    .filter((f) => len(f) > 0);
  if (!free.length) return { confirmed: false, reason: "no speech-free time after padding" };
  const guard = t.chunkSeamGuardMs / 1000;
  const unconfirmed = longest(
    free.filter((f) => !chunkSeams.some((s) => s > f.start - guard && s < f.end + guard)),
  );
  if (unconfirmed && len(unconfirmed) * 1000 >= t.minGapWithoutSilenceMs) return { safe: unconfirmed, confirmed: false };

  const best = longest(free)!;
  return {
    confirmed: false,
    reason: `speech-free gap too short (${Math.round(len(best) * 1000)}ms free; need ${t.minGapWithoutSilenceMs}ms away from chunk seams)`,
  };
}

/** Pure: build and score every scene-boundary candidate. */
export function computeCandidates(inp: CandidateInputs): Candidate[] {
  const { scenes, signals, scoring } = inp;
  // Deepgram speech intervals join the text segments as hard walls (source "deepgram" = audio-aligned).
  const segments: Segment[] = [
    ...inp.segments,
    ...inp.speech.map((s, i): Segment => ({ id: -1 - i, start: s.start, end: s.end, text: "", chunkIndex: -1, source: "deepgram" })),
  ];
  const out: Candidate[] = [];

  for (let k = 0; k < scenes.length - 1; k++) {
    const a = scenes[k];
    const b = scenes[k + 1];
    const c: Candidate = { id: `c${a.id}-${b.id}`, sceneBeforeId: a.id, sceneAfterId: b.id, gap: { start: a.end, end: b.start } };
    out.push(c);

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
  const key = hashJson({
    inputs,
    scenes: hashJson(scenes),
    segments: hashJson(transcript.segments),
    speech: hashJson(transcript.speech ?? []),
    signals: hashJson(signals),
  });
  const cached = ctx.force ? undefined : await readKeyed<Candidate[]>(out, key);
  if (cached) return cached;

  const candidates = computeCandidates({
    scenes,
    segments: transcript.segments,
    speech: transcript.speech ?? [],
    chunkSeams: transcript.chunkSeams,
    signals,
    ...inputs,
  });
  await writeKeyed(out, key, candidates);
  const ok = candidates.filter((c) => !c.rejected).length;
  ctx.log(`candidates: ${candidates.length} boundaries, ${ok} pass the Where check`);
  return candidates;
}
