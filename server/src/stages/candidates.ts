// Stage 5 ("Where"): a candidate per scene boundary. HARD RULE enforced here: the cut
// must be provably free of speech, in one of two ways (searched ±boundarySearchSec
// around the estimated scene change, because LLM timestamps drift):
//  1. measured ffmpeg silence (padded), outside every audio-aligned (Deepgram) word, or
//  2. a padded stretch where BOTH transcribers hear nothing: no Deepgram word (audio-
//     aligned) and no Gemini utterance, inside a chunk Deepgram covered, away from chunk
//     seams. This unlocks music-only transitions, where TV normally cuts to ads.
import fs from "node:fs/promises";
import path from "node:path";
import type { Candidate, IngestArtifact, Interval, Scene, ScoreWeights, Segment, Signals, Thresholds, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { transcribeDeepgram } from "../lib/deepgram";
import { encodeMp3Chunk } from "../lib/ffmpeg";
import { hashJson } from "../lib/hash";
import { mapLimit } from "../lib/pool";
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
  /** Where Deepgram succeeded; speech-free cuts are only allowed inside these ranges. */
  speechCoverage: Interval[];
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
  speechCoverage: Interval[] = [],
): { safe?: Interval; confirmed: boolean; basis?: "silence" | "speechFree"; reason?: string } {
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
  const pickBest = (xs: Interval[]) => xs.sort((a, b) => len(b) - len(a) || dist(a) - dist(b))[0];
  const confirmed = pickBest(quiet);
  if (confirmed) return { safe: confirmed, confirmed: true, basis: "silence" };

  // Second proof: both transcribers hear nothing. Every segment is a wall here (Gemini
  // utterances and Deepgram words, flagged ones included), only inside Deepgram coverage.
  if (t.allowSpeechFreeCuts && speechCoverage.length) {
    const guard = t.chunkSeamGuardMs / 1000;
    const speechFree = subtract(window, segments)
      .flatMap((f) => intersect(f, speechCoverage))
      .map((f) => ({ start: f.start + pad, end: f.end - pad }))
      .filter((f) => len(f) >= t.minSpeechFreeSec)
      .filter((f) => !chunkSeams.some((s) => s > f.start - guard && s < f.end + guard));
    const free = pickBest(speechFree);
    if (free) return { safe: free, confirmed: false, basis: "speechFree" };
  }

  if (t.requireSilenceConfirmation) {
    return {
      confirmed: false,
      reason:
        `no measured silence of ${minSilenceMs}ms` +
        (t.allowSpeechFreeCuts ? ` and no ${t.minSpeechFreeSec}s stretch where both transcribers hear no speech` : "") +
        ` within ±${t.boundarySearchSec}s of the scene change`,
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

    const r = findSafeInterval(c.gap, segments, signals.silences, inp.chunkSeams, inp.minSilenceMs, inp.thresholds, inp.speechCoverage);
    if (!r.safe) {
      c.rejected = { stage: "candidates", reason: r.reason! };
      continue;
    }
    c.cutBasis = r.basis;
    placeCut(c, r.safe, a, signals.shotCuts, scoring);
  }
  return out;
}

/** Pure: put the cut inside `safe` (on a shot cut if one falls there, else the midpoint) and score it. */
export function placeCut(c: Candidate, safe: Interval, before: Scene, shotCuts: number[], scoring: ScoreWeights) {
  c.safe = safe;
  const mid = (safe.start + safe.end) / 2;
  const shots = shotCuts.filter((t) => t >= safe.start && t <= safe.end);
  if (shots.length) {
    c.cutTime = shots.reduce((best, t) => (Math.abs(t - mid) < Math.abs(best - mid) ? t : best));
    c.snappedTo = "shotCut";
  } else {
    c.cutTime = mid;
    c.snappedTo = c.cutBasis === "silence" ? "silenceMidpoint" : "gapMidpoint";
  }
  const w = scoring.where;
  const parts = {
    // Real silence is preferred over a music-only (speech-free) gap.
    gap: Math.min(1, len(safe) / scoring.gapSaturationSec) * (c.cutBasis === "speechFree" ? scoring.speechFreeGapFactor : 1),
    shotCut: shots.length ? 1 : 0,
    closure: before.closure,
    calm: 1 - before.tension,
  };
  c.where = { ...parts, total: parts.gap * w.gap + parts.shotCut * w.shotCut + parts.closure * w.closure + parts.calm * w.calm };
}

/**
 * Pure: shrink a candidate's safe window by the words an independent re-listen heard
 * (each padded by `padSec`). Returns the best remaining window (longest; ties nearest the
 * original cut), or undefined when the re-listen heard speech throughout.
 */
export function applyRecheck(safe: Interval, heard: Interval[], padSec: number, originalCut: number): Interval | undefined {
  const free = subtract(
    safe,
    heard.map((w) => ({ start: w.start - padSec, end: w.end + padSec })),
  ).filter((f) => len(f) > 0.05);
  const dist = (f: Interval) => Math.abs((f.start + f.end) / 2 - originalCut);
  return free.sort((a, b) => len(b) - len(a) || dist(a) - dist(b))[0];
}

const MAX_RECHECK_CLIP_SEC = 30;

/** Deepgram on a short clip of just the cut window; words come back on the absolute timeline (capped). */
async function relisten(ctx: StageContext, wav: string, from: number, to: number): Promise<Interval[]> {
  const dir = artifactPath(ctx, "recheck");
  await fs.mkdir(dir, { recursive: true });
  const clip = path.join(dir, `clip_${from.toFixed(2)}_${to.toFixed(2)}.mp3`);
  await encodeMp3Chunk(wav, clip, from, to - from, "64k");
  const raw = await transcribeDeepgram(clip);
  const maxWord = ctx.config.deepgram.maxWordSec;
  const words: Interval[] = [];
  for (const u of raw?.results?.utterances ?? []) {
    for (const w of u.words ?? []) {
      const start = from + Number(w.start);
      words.push({ start, end: Math.min(from + Number(w.end), start + maxWord) });
    }
  }
  if (!words.length) {
    for (const w of raw?.results?.channels?.[0]?.alternatives?.[0]?.words ?? []) {
      const start = from + Number(w.start);
      words.push({ start, end: Math.min(from + Number(w.end), start + maxWord) });
    }
  }
  return words;
}

export async function runCandidates(
  ctx: StageContext,
  scenes: Scene[],
  transcript: Transcript,
  signals: Signals,
  ingest: IngestArtifact,
) {
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
    speech: hashJson([transcript.speech ?? [], transcript.speechCoverage ?? []]),
    signals: hashJson(signals),
    recheck: [ctx.config.thresholds.recheckCuts, ctx.config.thresholds.recheckPadSec, ctx.config.deepgram.model],
  });
  const cached = ctx.force ? undefined : await readKeyed<Candidate[]>(out, key);
  if (cached) return cached;

  const candidates = computeCandidates({
    scenes,
    segments: transcript.segments,
    speech: transcript.speech ?? [],
    speechCoverage: transcript.speechCoverage ?? [],
    chunkSeams: transcript.chunkSeams,
    signals,
    ...inputs,
  });

  if (ctx.config.thresholds.recheckCuts) {
    const sceneById = new Map(scenes.map((s) => [s.id, s]));
    const { recheckPadSec } = ctx.config.thresholds;
    await mapLimit(
      candidates.filter((c) => !c.rejected && c.safe),
      ctx.config.openrouter.concurrency,
      async (c) => {
        const safe = c.safe!;
        const from = Math.max(0, safe.start - 1);
        const to = Math.min(safe.end + 1, from + MAX_RECHECK_CLIP_SEC, ingest.meta.durationSec);
        let heard: Interval[];
        try {
          heard = await relisten(ctx, ingest.fullAudio, from, to);
        } catch (err) {
          c.rejected = { stage: "candidates", reason: `could not re-verify the cut (${(err as Error).message.slice(0, 120)})` };
          c.cutTime = undefined;
          return;
        }
        const window = { start: Math.max(safe.start, from + 0.05), end: Math.min(safe.end, to - 0.05) };
        const kept = applyRecheck(window, heard, recheckPadSec, c.cutTime!);
        const nearCut = heard.some((w) => w.end > c.cutTime! - recheckPadSec && w.start < c.cutTime! + recheckPadSec);
        c.recheck = { heardWords: heard.length, moved: nearCut && !!kept };
        if (!kept) {
          c.rejected = { stage: "candidates", reason: "independent re-listen heard speech across the whole cut window" };
          c.cutTime = undefined;
          return;
        }
        placeCut(c, kept, sceneById.get(c.sceneBeforeId)!, signals.shotCuts, ctx.config.scoring);
      },
    );
  }

  await writeKeyed(out, key, candidates);
  const ok = candidates.filter((c) => !c.rejected).length;
  const moved = candidates.filter((c) => c.recheck?.moved).length;
  const dropped = candidates.filter((c) => /re-listen|re-verify/.test(c.rejected?.reason ?? "")).length;
  ctx.log(`candidates: ${candidates.length} boundaries, ${ok} pass the Where check (re-listen moved ${moved}, dropped ${dropped})`);
  return candidates;
}
