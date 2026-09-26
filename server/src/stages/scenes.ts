// Stage 4: windowed transcript → LLM scene proposals (as segment ids) → validated,
// merged, contiguous scenes. The LLM never supplies a time; code derives every
// timestamp from the referenced segments.
import type { NegativeTag, Scene, Segment, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { chatJson } from "../lib/openrouter";
import { mapLimit } from "../lib/pool";
import {
  SCENES_PROMPT_VERSION,
  ScenesResponse,
  scenesJsonSchema,
  scenesSystemPrompt,
  scenesUserPrompt,
  type LlmScene,
} from "../prompts/scenes";
import { artifactPath, type StageContext } from "./context";

/** Pure: overlapping time windows over kept segments. */
export function makeWindows(segments: Segment[], windowSec: number, overlapSec: number): Segment[][] {
  if (!segments.length) return [];
  const step = Math.max(1, windowSec - overlapSec);
  const t0 = segments[0].start;
  const tEnd = segments[segments.length - 1].start;
  const windows: Segment[][] = [];
  for (let ws = t0; ; ws += step) {
    const w = segments.filter((s) => s.start >= ws && s.start < ws + windowSec);
    if (w.length) windows.push(w);
    if (ws + windowSec > tEnd) break;
  }
  return windows;
}

/**
 * Pure: reject scene proposals that reference ids outside the window or are
 * malformed. Throws if nothing valid remains (caller retries / fails safe).
 */
export function validateWindowScenes(proposed: LlmScene[], window: Segment[], vocab: string[]): LlmScene[] {
  const ids = new Set(window.map((s) => s.id));
  const vocabSet = new Set(vocab);
  const errors: string[] = [];
  const valid = proposed.filter((sc, i) => {
    if (!ids.has(sc.first_segment_id) || !ids.has(sc.last_segment_id)) {
      errors.push(`scene ${i}: unknown segment id ${sc.first_segment_id}..${sc.last_segment_id}`);
      return false;
    }
    if (sc.first_segment_id > sc.last_segment_id) {
      errors.push(`scene ${i}: first_segment_id > last_segment_id`);
      return false;
    }
    return true;
  });
  for (const sc of valid) sc.negative_contexts = sc.negative_contexts.filter((n) => vocabSet.has(n.context));
  if (!valid.length) throw new Error(`no valid scenes: ${errors.join("; ") || "empty response"}`);
  return valid;
}

async function proposeScenes(ctx: StageContext, window: Segment[], wi: number): Promise<LlmScene[]> {
  const vocab = ctx.catalogue.negativeVocab;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const user =
        scenesUserPrompt(window) +
        (lastErr ? `\n\nYour previous answer was rejected: ${lastErr}. Use only the segment ids shown above.` : "");
      const raw = await chatJson({
        label: `scenes window ${wi}`,
        system: scenesSystemPrompt(vocab),
        user,
        schemaName: "scenes",
        schema: scenesJsonSchema(vocab),
      });
      return validateWindowScenes(ScenesResponse.parse(raw).scenes, window, vocab);
    } catch (err) {
      lastErr = (err as Error).message.slice(0, 500);
      ctx.log(`scenes window ${wi} attempt ${attempt + 1} rejected: ${lastErr}`);
    }
  }
  // Fail safe: this window contributes no boundaries and its segments stay unclassified.
  return [];
}

interface Proposal extends LlmScene {
  window: number;
}

/**
 * Pure: merge per-window proposals into contiguous scenes over kept segments.
 * - Boundaries = union of proposed scene starts, deduped when closer than `minSceneSegments`.
 * - Attributes come from the proposal covering the scene's last segment with most overlap.
 * - Negative tags = union over every overlapping proposal (max confidence per context).
 * - Any segment no proposal covers makes the scene unclassified (confidence 0).
 */
export function mergeScenes(kept: Segment[], proposals: Proposal[], minSceneSegments = 2): Scene[] {
  if (!kept.length) return [];
  const pos = new Map(kept.map((s, i) => [s.id, i]));
  const range = (p: Proposal) => [pos.get(p.first_segment_id)!, pos.get(p.last_segment_id)!] as const;

  // Candidate boundary positions (index into kept where a new scene starts).
  const starts = [...new Set(proposals.map((p) => range(p)[0]))].filter((i) => i > 0).sort((a, b) => a - b);

  // Dedupe near-duplicate boundaries (typically from overlapping windows): keep the one
  // preceded by the larger speech gap, since that is the better cut.
  const gapBefore = (i: number) => kept[i].start - kept[i - 1].end;
  const boundaries: number[] = [];
  for (const b of starts) {
    const prev = boundaries[boundaries.length - 1];
    if (prev !== undefined && b - prev < minSceneSegments) {
      if (gapBefore(b) > gapBefore(prev)) boundaries[boundaries.length - 1] = b;
    } else boundaries.push(b);
  }

  const edges = [0, ...boundaries, kept.length];
  const scenes: Scene[] = [];
  for (let k = 0; k < edges.length - 1; k++) {
    const lo = edges[k];
    const hi = edges[k + 1] - 1;
    const overlapping = proposals
      .map((p) => {
        const [a, b] = range(p);
        return { p, a, b, n: Math.max(0, Math.min(b, hi) - Math.max(a, lo) + 1) };
      })
      .filter((x) => x.n > 0);

    let covered = true;
    for (let i = lo; i <= hi && covered; i++) covered = overlapping.some(({ a, b }) => a <= i && i <= b);

    const endCoverers = overlapping.filter(({ a, b }) => a <= hi && hi <= b);
    const primary = (endCoverers.length ? endCoverers : overlapping).sort((x, y) => y.n - x.n)[0]?.p;

    const tags = new Map<string, number>();
    for (const { p } of overlapping) {
      for (const n of p.negative_contexts) tags.set(n.context, Math.max(tags.get(n.context) ?? 0, n.confidence));
    }
    const negativeTags: NegativeTag[] = [...tags].map(([context, confidence]) => ({
      context,
      confidence,
      source: "transcript",
    }));

    scenes.push({
      id: k,
      firstSegmentId: kept[lo].id,
      lastSegmentId: kept[hi].id,
      start: kept[lo].start,
      end: kept[hi].end,
      summary: primary?.summary ?? "",
      activity: primary?.activity ?? "",
      mood: primary?.mood ?? "",
      closure: primary?.closure ?? 0,
      tension: primary?.tension ?? 1,
      confidence: covered && primary ? Math.min(...overlapping.map(({ p }) => p.confidence)) : 0,
      negativeTags,
    });
  }
  return scenes;
}

export async function runScenes(ctx: StageContext, transcript: Transcript): Promise<Scene[]> {
  const out = artifactPath(ctx, ARTIFACTS.scenes);
  const key = hashJson({
    v: SCENES_PROMPT_VERSION,
    vocab: ctx.catalogue.negativeVocab,
    model: ctx.config.openrouter.reasonModel,
    w: ctx.config.scenes,
    transcript: hashJson(transcript.segments.map((x) => [x.id, x.start, x.end, x.text, !!x.dropped])),
  });
  const cached = ctx.force ? undefined : await readKeyed<Scene[]>(out, key);
  if (cached) return cached;

  const kept = transcript.segments.filter((s) => !s.dropped);
  const windows = makeWindows(kept, ctx.config.scenes.windowSec, ctx.config.scenes.overlapSec);
  const perWindow = await mapLimit(windows, ctx.config.openrouter.concurrency, (w, i) => proposeScenes(ctx, w, i));
  const proposals = perWindow.flatMap((ps, window) => ps.map((p) => ({ ...p, window })));
  const scenes = mergeScenes(kept, proposals);

  await writeKeyed(out, key, scenes);
  const unclassified = scenes.filter((s) => s.confidence < ctx.config.thresholds.sceneMinConfidence).length;
  ctx.log(`scenes: ${windows.length} windows → ${scenes.length} scenes (${unclassified} low-confidence)`);
  return scenes;
}
