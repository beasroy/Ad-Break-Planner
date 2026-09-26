// LLM ad placement (config.placement.mode = "llm"). One LLM call per transcription chunk (the audio
// pieces from ingest) reads that chunk's dialogue, with the measured silences and shot cuts written
// in, and picks the line after which an ad plays and the brand. The model only makes the judgement
// call. Code decides where exactly the cut goes and enforces every safety rule (minimum gap, ad
// load, negative contexts, speech at the cut, previous brand); a pick that
// fails falls back to the model's alternatives, and if none pass the chunk stays empty.
import fs from "node:fs/promises";
import type { Brand, Break, Catalogue, IngestArtifact, Interval, MatchedCandidate, ProgrammeContext, Segment, SelectionLog, Signals, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { chatJson } from "../lib/openrouter";
import {
  PLACEMENT_PROMPT_VERSION,
  PlacementResponse,
  placementJsonSchema,
  placementSystemPrompt,
  placementUserPrompt,
  type PlacementAnswer,
  type PlacementBrand,
} from "../prompts/placement";
import { ProgrammeResponse, STORY_PROMPT_VERSION, programmeJsonSchema, storySystemPrompt, storyUserPrompt } from "../prompts/programme";
import { artifactPath, type StageContext } from "./context";
import { listenCheck } from "./match";
import { pickCreative } from "./select";

/** Bump when the chunk, cut or check logic below changes, so cached placements are recomputed. */
export const PLACEMENT_LOGIC_VERSION = 8;

/** Tolerance for "at least N seconds" on times that are sums of floats (1.5 s must not come out as 1.4999…). */
const EPS = 1e-6;

/** Pure: measured silences sorted, with pieces that touch (ffmpeg splits long silences) joined. */
export function mergeSilences(silences: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of [...silences].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && x.start - last.end < 0.05) last.end = Math.max(last.end, x.end);
    else out.push({ start: x.start, end: x.end });
  }
  return out;
}

/**
 * Pure: dialogue lines numbered ("P1.", "1.", "N1."), with measured silences and shot cuts
 * between them where they happen, as unnumbered marker lines.
 */
export function renderLines(
  lines: Segment[],
  prefix: string,
  signals: { silences: Interval[]; shotCuts: number[] },
  o: { from: number; to: number; showSilenceMinSec: number },
): string {
  const items: { t: number; text: string }[] = lines.map((l, i) => ({
    t: l.start,
    text: `${prefix}${i + 1}. [${l.start.toFixed(1)}–${l.end.toFixed(1)}] ${l.text}`,
  }));
  for (const x of signals.silences) {
    const len = x.end - x.start;
    if (len >= o.showSilenceMinSec && x.start >= o.from && x.start < o.to)
      items.push({ t: x.start, text: `    · silence ${len.toFixed(1)}s [${x.start.toFixed(1)}–${x.end.toFixed(1)}]` });
  }
  for (const c of signals.shotCuts) if (c >= o.from && c < o.to) items.push({ t: c, text: `    · shot cut [${c.toFixed(1)}]` });
  return items
    .sort((a, b) => a.t - b.t)
    .map((x) => x.text)
    .join("\n");
}

/**
 * Pure: where exactly the ad cuts in after a chosen line. Inside a measured silence in the gap
 * before the next line, of any length (on a shot cut if one falls in it, else its middle); else,
 * in the earliest stretch of the pause with no transcribed word for at least minSpeechFreeSec
 * (music may play). Undefined, with a reason, when there is neither. The listen check at the cut is
 * the final gate against speech.
 */
export function cutAfterLine(
  line: Segment,
  following: Segment | undefined,
  s: { silences: Interval[]; shotCuts: number[]; speech: Interval[] },
  o: { minSpeechFreeSec: number; padSec: number; durationSec: number },
): { cutTime?: number; basis?: "silence" | "speechFree"; pauseSec: number; reason?: string } {
  const gapStart = line.end;
  const gapEnd = Math.min(following ? following.start : line.end + 10, o.durationSec);
  const pauseSec = Math.max(0, gapEnd - gapStart);
  const clear = (t: number) => !s.speech.some((w) => w.start < t + o.padSec && w.end > t - o.padSec);
  const within = (a: number, b: number) => s.shotCuts.filter((c) => c > a + o.padSec && c < b - o.padSec);

  const best = s.silences
    .map((x) => ({ start: Math.max(x.start, gapStart), end: Math.min(x.end, gapEnd) }))
    .filter((x) => x.end - x.start > EPS)
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (best) {
    const mid = (best.start + best.end) / 2;
    const cut = within(best.start, best.end).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] ?? mid;
    if (clear(cut)) return { cutTime: cut, basis: "silence", pauseSec };
  }
  // No usable silence: take the earliest stretch of the pause with no transcribed word for at least
  // minSpeechFreeSec (music may play), i.e. the one closest to where the conversation ended.
  const need = `no measured silence and no ${o.minSpeechFreeSec}s stretch without transcribed words`;
  if (pauseSec < o.minSpeechFreeSec - EPS) return { pauseSec, reason: `only ${pauseSec.toFixed(1)}s before the next line, ${need}` };
  const free = freeIntervals({ start: gapStart, end: gapEnd }, s.speech, o.padSec).find((x) => x.end - x.start >= o.minSpeechFreeSec - EPS);
  if (!free) return { pauseSec, reason: `transcribed words fill the ${pauseSec.toFixed(1)}s pause after this line, ${need}` };
  const mid = (free.start + free.end) / 2;
  const cut = within(free.start, free.end).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0] ?? mid;
  return { cutTime: cut, basis: "speechFree", pauseSec };
}

/** Pure: the parts of `span` not covered by any word (each word widened by pad), in time order. */
export function freeIntervals(span: Interval, words: Interval[], pad: number): Interval[] {
  const out: Interval[] = [];
  let t = span.start;
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    const ws = w.start - pad;
    const we = w.end + pad;
    if (we <= t || ws >= span.end) continue;
    if (ws > t) out.push({ start: t, end: Math.min(ws, span.end) });
    t = Math.max(t, we);
    if (t >= span.end) break;
  }
  if (t < span.end) out.push({ start: t, end: span.end });
  return out;
}

/**
 * Pure: the safety rules code enforces on one option from the model. Empty = passes.
 * Relies on the contexts the model reported as nearby (there is no separate scene analysis).
 */
export function checkOption(
  o: { brandId: string; fit: number },
  d: { brands: Brand[]; previousBrand?: string; blockAll: string[]; contextsNearby: string[]; minBrandFit: number },
): string[] {
  const problems: string[] = [];
  const brand = d.brands.find((b) => b.id === o.brandId);
  if (!brand) return [`unknown brand ${o.brandId}`];
  if (o.brandId === d.previousBrand) problems.push("same brand as the previous break");
  const reported = new Set(d.contextsNearby.map((c) => c.trim().toLowerCase()));
  const own = brand.negativeContexts.filter((c) => reported.has(c));
  if (own.length) problems.push(`model reported ${own.join(", ")} nearby, which ${brand.name} must never be next to`);
  const all = d.blockAll.filter((c) => reported.has(c));
  if (all.length) problems.push(`model reported ${all.join(", ")} nearby, which blocks every brand`);
  if (o.fit < d.minBrandFit) problems.push(`fit ${o.fit.toFixed(2)} below ${d.minBrandFit}`);
  return problems;
}

/**
 * The episode summary shown to every placement call as background, read straight from the dialogue
 * (one call, cached in programme.json). Best effort: placement works without it.
 */
export async function runStory(ctx: StageContext, transcript: Transcript): Promise<ProgrammeContext | undefined> {
  const out = artifactPath(ctx, ARTIFACTS.programme);
  const lines = transcript.segments.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
  const key = hashJson({ v: STORY_PROMPT_VERSION, model: ctx.config.openrouter.reasonModel, lines: hashJson(lines) });
  const cached = ctx.force ? undefined : await readKeyed<ProgrammeContext>(out, key);
  if (cached) return cached;
  if (!lines.length) return undefined;
  try {
    const p = ProgrammeResponse.parse(
      await chatJson({ label: "story", system: storySystemPrompt, user: storyUserPrompt(lines), schemaName: "programme", schema: programmeJsonSchema }),
    );
    const story: ProgrammeContext = { summary: p.summary, genre: p.genre, recurringContexts: p.recurring_contexts.slice(0, 8) };
    await writeKeyed(out, key, story);
    ctx.log(`story: ${story.genre} — ${story.recurringContexts.join(", ")}`);
    return story;
  } catch (err) {
    ctx.log(`story summary failed (${(err as Error).message.slice(0, 200)}); placing without it`);
    return undefined;
  }
}

/** One LLM call's worth of work: the log for a chunk. `slot` is the chunk number (1-based). */
export interface SlotLog {
  slot: number;
  window: [number, number];
  currentLines: number;
  prompt?: string;
  answer?: PlacementAnswer;
  error?: string;
  options: {
    lineId: number;
    brandId: string;
    fit: number;
    reason: string;
    cutTime?: number;
    basis?: string;
    outcome: "accepted" | "rejected";
    problems: string[];
  }[];
  accepted?: { lineId: number; brandId: string; cutTime: number; creativeId: string };
}

const toPlacementBrand = (b: Brand): PlacementBrand => ({
  brand_id: b.id,
  name: b.name,
  category: b.category,
  fits_scenes_about: b.targetContexts,
  never_next_to: b.negativeContexts,
});

/** The "block every brand" contexts: listed by more than consensusNegativeShare of the brands. */
const blockAllContexts = (c: Catalogue, share: number) =>
  c.negativeVocab.filter((ctx) => c.brands.filter((b) => b.negativeContexts.includes(ctx)).length / c.brands.length > share);

export async function runPlacement(
  ctx: StageContext,
  ingest: IngestArtifact,
  transcript: Transcript,
  signals: Signals,
): Promise<{ breaks: Break[]; log: SelectionLog[]; slots: SlotLog[] }> {
  const cfg = ctx.config;
  const out = artifactPath(ctx, ARTIFACTS.placement);
  const programme = await runStory(ctx, transcript);
  const key = hashJson({
    v: PLACEMENT_PROMPT_VERSION,
    logic: PLACEMENT_LOGIC_VERSION,
    model: cfg.openrouter.reasonModel,
    catalogue: ctx.catalogue.hash,
    placement: cfg.placement,
    pacing: cfg.pacing,
    thresholds: cfg.thresholds,
    listen: cfg.listen,
    segments: hashJson(transcript.segments),
    speech: hashJson(transcript.speech ?? []),
    signals: hashJson(signals),
    programme,
  });
  const cached = ctx.force ? undefined : await readKeyed<{ breaks: Break[]; log: SelectionLog[]; slots: SlotLog[] }>(out, key);
  if (cached) return cached;

  // Fresh per run: request + response for every placement LLM call, for debugging prompts/answers.
  const llmLog = artifactPath(ctx, "placement-llm.jsonl");
  await fs.writeFile(llmLog, "").catch(() => {});

  const duration = ingest.meta.durationSec;
  const lines = transcript.segments.filter((s) => !s.dropped).sort((a, b) => a.start - b.start);
  const silences = mergeSilences(signals.silences);
  const shotCuts = signals.shotCuts;
  const speech = transcript.speech ?? [];
  const brands = ctx.catalogue.brands;
  const blockAll = blockAllContexts(ctx.catalogue, cfg.thresholds.consensusNegativeShare);
  const brandName = (id?: string) => (id ? brands.find((b) => b.id === id)?.name ?? id : undefined);
  // One window per transcription chunk.
  const windows = ingest.chunks.map((c) => ({ chunk: c.index + 1, from: c.offsetSec, to: c.offsetSec + c.durationSec }));

  const logs: SlotLog[] = [];
  const breaks: Break[] = [];
  const shown: string[] = [];
  let previousBrand: string | undefined;
  let lastCut = -Infinity;
  let adSecondsLeft = cfg.pacing.maxAdLoadPct * duration;

  // Chunks in order: each call knows the brands already placed before it.
  for (const w of windows) {
    // Never closer than placement.minGapSec to the previous ad.
    const from = Math.max(w.from, lastCut + cfg.placement.minGapSec);
    const current = from < w.to ? lines.filter((l) => l.end >= from && l.end <= w.to) : [];
    const prev = lines.filter((l) => l.end < from && l.end >= from - cfg.placement.contextSec);
    const next = lines.filter((l) => l.start > w.to && l.start <= w.to + cfg.placement.contextSec);
    const log: SlotLog = { slot: w.chunk, window: [from, w.to], currentLines: current.length, options: [] };
    logs.push(log);
    if (!current.length) {
      log.error = from >= w.to ? "the whole chunk is within the minimum gap after the previous ad" : "no dialogue in this chunk";
      continue;
    }
    const sig = { silences, shotCuts };
    const show = cfg.placement.showSilenceMinSec;
    const selectable = brands.filter((b) => b.id !== previousBrand);
    const system = placementSystemPrompt({ blockAll, previousBrandName: brandName(previousBrand), lineCount: current.length });
    const user = placementUserPrompt({
      storySoFar: programme?.summary ?? "",
      brands: brands.map(toPlacementBrand),
      brandsAlreadyShown: shown.map((id) => brandName(id)!),
      previousBrandName: brandName(previousBrand),
      previousLines: renderLines(prev, "P", sig, { from: prev[0]?.start ?? from, to: current[0].start, showSilenceMinSec: show }),
      currentLines: renderLines(current, "", sig, {
        from: current[0].start,
        to: next[0]?.start ?? current.at(-1)!.end + 10,
        showSilenceMinSec: show,
      }),
      nextLines: renderLines(next, "N", sig, { from: next[0]?.start ?? w.to, to: (next.at(-1)?.end ?? w.to) + 1, showSilenceMinSec: show }),
    });
    log.prompt = user;

    let answer: PlacementAnswer;
    try {
      answer = PlacementResponse.parse(
        await chatJson({
          label: `placement chunk ${w.chunk}`,
          system,
          user,
          schemaName: "ad_slot_plan",
          schema: placementJsonSchema({
            lineCount: current.length,
            brandIds: selectable.map((b) => b.id),
            contexts: ctx.catalogue.negativeVocab,
          }),
          logFile: llmLog,
        }),
      );
    } catch (err) {
      // When unsure, don't place: a failed call leaves the chunk empty.
      log.error = `placement call failed: ${(err as Error).message.slice(0, 200)}`;
      continue;
    }
    log.answer = answer;

    // The model's pick, then its alternatives, in order; the first that passes every check wins.
    for (const o of [answer.placement, ...answer.alternatives].filter((x): x is NonNullable<typeof x> => !!x)) {
      const entry: SlotLog["options"][number] = { lineId: o.line_id, brandId: o.brand_id, fit: o.fit, reason: o.reason, outcome: "rejected", problems: [] };
      log.options.push(entry);
      if (log.accepted) {
        entry.problems.push("not needed: an earlier option was accepted");
        continue;
      }
      const line = current[o.line_id - 1];
      if (!line) {
        entry.problems.push(`line ${o.line_id} is not one of this chunk's lines`);
        continue;
      }
      const cut = cutAfterLine(line, current[o.line_id] ?? next[0], { silences, shotCuts, speech }, {
        minSpeechFreeSec: cfg.thresholds.minSpeechFreeSec,
        padSec: cfg.thresholds.cutPaddingMs / 1000,
        durationSec: duration,
      });
      if (cut.cutTime === undefined) {
        entry.problems.push(`no safe pause after this line: ${cut.reason}`);
        continue;
      }
      entry.cutTime = cut.cutTime;
      entry.basis = cut.basis;
      entry.problems.push(
        ...checkOption(
          { brandId: o.brand_id, fit: o.fit },
          { brands, previousBrand, blockAll, contextsNearby: answer.contexts_nearby, minBrandFit: cfg.thresholds.minBrandFit },
        ),
      );
      if (entry.problems.length) continue;

      // Final gate, same as the rule-based pipeline: nobody speaking at the cut (VAD, then LLM if unsure).
      const probe = { id: `chunk${w.chunk}-line${o.line_id}`, cutTime: cut.cutTime } as MatchedCandidate;
      if (cfg.thresholds.listenCheckCuts) {
        await listenCheck(ctx, probe, ingest.fullAudio, duration, speech);
        if (probe.rejected) {
          entry.problems.push(probe.rejected.reason);
          continue;
        }
      }
      const brand = brands.find((b) => b.id === o.brand_id)!;
      const creative = pickCreative(brand, adSecondsLeft, cfg.contentLanguage);
      if (!creative) {
        entry.problems.push("no ad of this brand fits the remaining ad time");
        continue;
      }
      entry.outcome = "accepted";
      log.accepted = { lineId: o.line_id, brandId: o.brand_id, cutTime: cut.cutTime, creativeId: creative.id };
      adSecondsLeft -= creative.durationSec;
      lastCut = cut.cutTime;
      previousBrand = o.brand_id;
      if (!shown.includes(o.brand_id)) shown.push(o.brand_id);
      breaks.push({
        candidateId: `slot-${w.chunk}`,
        timeSec: cut.cutTime,
        brandId: o.brand_id,
        creativeId: creative.id,
        adDurationSec: creative.durationSec,
        whereScore: Math.min(1, cut.pauseSec / 3),
        fit: o.fit,
        combinedScore: o.fit,
        reason: o.reason,
      });
    }
  }

  const log: SelectionLog[] = logs.map((l) =>
    l.accepted
      ? { candidateId: `slot-${l.slot}`, outcome: "selected", reason: `${brandName(l.accepted.brandId)} after line ${l.accepted.lineId}` }
      : {
          candidateId: `slot-${l.slot}`,
          outcome: "rejected",
          reason:
            l.error ??
            (l.options.length
              ? l.options.map((o) => `line ${o.lineId} ${brandName(o.brandId)}: ${o.problems.join("; ")}`).join(" | ")
              : `model placed no ad: ${l.answer?.why_not_others ?? ""}`),
        },
  );
  const result = { breaks, log, slots: logs };
  await writeKeyed(out, key, result);
  ctx.log(`placement: ${windows.length} chunks, ${breaks.length} ads placed (${breaks.map((b) => `${Math.round(b.timeSec)}s ${b.brandId}`).join(", ") || "none"})`);
  return result;
}
