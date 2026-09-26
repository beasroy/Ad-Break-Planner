// Stage 2: transcribe each audio chunk (parallel, raw responses cached per chunk), then
// merge onto one timeline and flag likely hallucinations. Flagged segments stay in the
// artifact with `dropped` set: they are hidden from the LLM but still block cuts.
// Default provider is an audio-capable LLM (Gemini): whisper-1's Bengali was unusable
// (repetition loops, Devanagari output, missed speech). Whisper remains as a fallback.
import fs from "node:fs/promises";
import path from "node:path";
import type { AudioChunk, IngestArtifact, Interval, Segment, Signals, Thresholds, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed, exists, readJson, writeJson } from "../lib/artifacts";
import { hashJson } from "../lib/hash";
import { chatJson, transcribeWhisper } from "../lib/openrouter";
import { mapLimit } from "../lib/pool";
import {
  TRANSCRIBE_PROMPT_VERSION,
  TranscribeResponse,
  transcribeJsonSchema,
  transcribeSystemPrompt,
  transcribeUserText,
} from "../prompts/transcribe";
import { artifactPath, type StageContext } from "./context";

export interface RawChunkResult {
  chunkIndex: number;
  raw: any;
}

/** Bump when merge/filter logic changes so cached transcripts are rebuilt (raw chunk responses are reused). */
const TRANSCRIPT_BUILD_VERSION = 3;

const providerTag = (ctx: StageContext) => {
  const or = ctx.config.openrouter;
  const model = or.transcribeProvider === "whisper" ? or.whisperModel : or.transcribeModel;
  return `${or.transcribeProvider}-${model.replace(/[^a-z0-9.-]+/gi, "_")}-v${TRANSCRIBE_PROMPT_VERSION}`;
};

async function transcribeWithLlm(ctx: StageContext, chunk: AudioChunk): Promise<{ utterances: { start: number; end: number; text: string }[] }> {
  const data = (await fs.readFile(chunk.file)).toString("base64");
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await chatJson({
        label: `transcribe chunk ${chunk.index}`,
        model: ctx.config.openrouter.transcribeModel,
        system: transcribeSystemPrompt,
        user: [
          { type: "text", text: transcribeUserText },
          { type: "input_audio", input_audio: { data, format: path.extname(chunk.file).slice(1) } },
        ],
        schemaName: "transcript",
        schema: transcribeJsonSchema,
      });
      return TranscribeResponse.parse(raw);
    } catch (err) {
      lastErr = (err as Error).message.slice(0, 300);
      ctx.log(`transcribe chunk ${chunk.index} attempt ${attempt + 1} failed: ${lastErr}`);
    }
  }
  // Fail the stage rather than leave a hole: a missing chunk could hide a sensitive scene.
  throw new Error(`transcription failed for chunk ${chunk.index}: ${lastErr}`);
}

/** Transcribes every chunk that has no cached raw response for the current provider/model. */
export async function transcribeChunks(ctx: StageContext, ingest: IngestArtifact): Promise<RawChunkResult[]> {
  const rawDir = artifactPath(ctx, path.join("transcribe", providerTag(ctx)));
  await fs.mkdir(rawDir, { recursive: true });
  const whisper = ctx.config.openrouter.transcribeProvider === "whisper";
  let loggedFields = false;

  return mapLimit(ingest.chunks, ctx.config.openrouter.concurrency, async (chunk) => {
    const cached = path.join(rawDir, `chunk_${String(chunk.index).padStart(3, "0")}.json`);
    if (!ctx.force && (await exists(cached))) return { chunkIndex: chunk.index, raw: await readJson(cached) };

    const raw = whisper ? await transcribeWhisper(chunk.file) : await transcribeWithLlm(ctx, chunk);
    if (whisper && !Array.isArray(raw?.segments)) {
      throw new Error(`Whisper returned no segments for chunk ${chunk.index}; keys: ${Object.keys(raw ?? {}).join(",")}`);
    }
    if (whisper && !loggedFields && raw.segments[0]) {
      loggedFields = true;
      ctx.log(`whisper segment fields: ${Object.keys(raw.segments[0]).join(", ")}`);
    }
    await writeJson(cached, raw);
    return { chunkIndex: chunk.index, raw };
  });
}

const overlap = (a: Interval, b: Interval) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

export function silenceCoverage(seg: Interval, silences: Interval[]): number {
  const len = seg.end - seg.start;
  if (len <= 0) return 1;
  let covered = 0;
  for (const s of silences) {
    if (s.start >= seg.end) break;
    covered += overlap(seg, s);
  }
  return covered / len;
}

/**
 * `approxTiming`: LLM transcripts have good text but timestamps that can drift by
 * seconds, so the silence-overlap rule would throw away real dialogue. It only
 * applies to Whisper output, whose timing is audio-aligned.
 */
export function hallucinationReason(seg: Segment, silences: Interval[], t: Thresholds, approxTiming = false): string | undefined {
  if (!seg.text.trim()) return "empty text";
  const cov = approxTiming ? 0 : silenceCoverage(seg, silences);
  if (cov >= t.hallucinationSilenceOverlap) return `${Math.round(cov * 100)}% inside silence`;
  if (seg.noSpeechProb !== undefined && seg.noSpeechProb >= t.hallucinationNoSpeechProbAlone) {
    return `no_speech_prob ${seg.noSpeechProb.toFixed(2)}`;
  }
  if (
    seg.noSpeechProb !== undefined &&
    seg.avgLogprob !== undefined &&
    seg.noSpeechProb >= t.hallucinationNoSpeechProb &&
    seg.avgLogprob <= t.hallucinationAvgLogprob
  ) {
    return `no_speech_prob ${seg.noSpeechProb.toFixed(2)}, avg_logprob ${seg.avgLogprob.toFixed(2)}`;
  }
  if (seg.compressionRatio !== undefined && seg.compressionRatio >= t.hallucinationCompressionRatio) {
    return `compression_ratio ${seg.compressionRatio.toFixed(2)} (repetitive)`;
  }
  return undefined;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Pure: shift chunk-relative segments to absolute time, sort, assign ids, flag hallucinations. */
export interface UtteranceOpts {
  utterancePauseSec: number;
  maxUtteranceSec: number;
}

type Piece = Omit<Segment, "id">;
const MIN_WORD_SEC = 0.05;

/**
 * Pure: one chunk's raw response → utterance segments on the absolute timeline.
 * Whisper's own segments for Bengali are ~30s blocks that swallow pauses, so we
 * group word timestamps into utterances split at pauses, and only use Whisper
 * segments for their confidence fields. Whisper segments with no words inside
 * them are kept as-is (coarse, but they still count as occupied time).
 */
export function chunkUtterances(raw: any, chunk: AudioChunk, opts: UtteranceOpts): Piece[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;

  // LLM provider: utterances with chunk-relative times. Clamp to the chunk; drop malformed ones.
  if (Array.isArray(raw.utterances)) {
    return raw.utterances
      .map((u: any) => ({
        start: off + Math.max(0, Number(u.start)),
        end: Math.min(off + Number(u.end), chunkEnd),
        text: String(u.text ?? "").trim(),
        chunkIndex: chunk.index,
      }))
      .filter((u: Piece) => Number.isFinite(u.start) && Number.isFinite(u.end) && u.end > u.start && u.text);
  }

  const segs: Piece[] = (raw.segments ?? [])
    .map((s: any) => ({
      start: off + Number(s.start),
      end: Math.min(off + Number(s.end), chunkEnd),
      text: String(s.text ?? "").trim(),
      chunkIndex: chunk.index,
      noSpeechProb: num(s.no_speech_prob),
      avgLogprob: num(s.avg_logprob),
      compressionRatio: num(s.compression_ratio),
    }))
    .filter((s: Piece) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);

  type Word = Interval & { text: string };
  const words: Word[] = (raw.words ?? [])
    .map((w: any): Word => ({
      start: off + Number(w.start),
      end: Math.min(off + Number(w.end), chunkEnd),
      text: String(w.word ?? "").trim(),
    }))
    .filter((w: Word) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start && w.text)
    .sort((a: Interval, b: Interval) => a.start - b.start);

  if (!words.length) return segs;

  const parentOf = (w: Interval) => {
    const mid = (w.start + w.end) / 2;
    return segs.find((s) => mid >= s.start && mid <= s.end) ?? segs.find((s) => w.start < s.end && w.end > s.start);
  };

  const out: Piece[] = [];
  const used = new Set<Piece>();
  let cur: Word[] = [];
  let curParent: Piece | undefined;
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    const end = Math.max(cur[cur.length - 1].end, start + MIN_WORD_SEC);
    if (curParent) used.add(curParent);
    out.push({
      start,
      end,
      text: cur.map((w) => w.text).join(" "),
      chunkIndex: chunk.index,
      noSpeechProb: curParent?.noSpeechProb,
      avgLogprob: curParent?.avgLogprob,
      compressionRatio: curParent?.compressionRatio,
    });
    cur = [];
  };

  for (const w of words) {
    const parent = parentOf(w);
    const last = cur[cur.length - 1];
    if (
      last &&
      (w.start - last.end >= opts.utterancePauseSec || w.end - cur[0].start > opts.maxUtteranceSec || parent !== curParent)
    ) {
      flush();
    }
    if (!cur.length) curParent = parent;
    cur.push(w);
  }
  flush();

  for (const s of segs) if (!used.has(s) && s.text) out.push(s);
  return out;
}

export function buildTranscript(
  results: RawChunkResult[],
  chunks: AudioChunk[],
  silences: Interval[],
  t: Thresholds,
  opts: UtteranceOpts,
): Transcript {
  const fields = new Set<string>();
  const merged: Piece[] = [];
  const approx = new Set<Piece>();
  const sortedSilences = [...silences].sort((a, b) => a.start - b.start);

  for (const { chunkIndex, raw } of results) {
    const chunk = chunks.find((c) => c.index === chunkIndex);
    if (!chunk) throw new Error(`Unknown chunk ${chunkIndex}`);
    for (const s of raw.segments ?? []) Object.keys(s).forEach((k) => fields.add(k));
    for (const u of raw.utterances ?? []) Object.keys(u).forEach((k) => fields.add(`utterances.${k}`));
    for (const w of raw.words ?? []) Object.keys(w).forEach((k) => fields.add(`words.${k}`));
    const pieces = chunkUtterances(raw, chunk, opts);
    if (Array.isArray(raw.utterances)) pieces.forEach((p) => approx.add(p));
    merged.push(...pieces);
  }

  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: Segment[] = merged.map((s, id) => {
    const seg: Segment = approx.has(s) ? { id, ...s, approxTiming: true } : { id, ...s };
    const reason = hallucinationReason(seg, sortedSilences, t, approx.has(s));
    return reason ? { ...seg, dropped: { reason } } : seg;
  });

  const chunkSeams = chunks.slice(1).map((c) => c.offsetSec);
  return { segments, chunkSeams, rawFieldsSeen: [...fields].sort() };
}

export async function runTranscribe(
  ctx: StageContext,
  ingest: IngestArtifact,
  raw: RawChunkResult[],
  signals: Signals,
): Promise<Transcript> {
  const out = artifactPath(ctx, ARTIFACTS.transcript);
  const key = hashJson({ v: TRANSCRIPT_BUILD_VERSION, p: providerTag(ctx), t: ctx.config.thresholds, o: ctx.config.transcription, c: ingest.chunks.length });
  const cached = ctx.force ? undefined : await readKeyed<Transcript>(out, key);
  if (cached) return cached;
  const transcript = buildTranscript(raw, ingest.chunks, signals.silences, ctx.config.thresholds, ctx.config.transcription);
  await writeKeyed(out, key, transcript);
  const dropped = transcript.segments.filter((s) => s.dropped).length;
  ctx.log(`transcript: ${transcript.segments.length} segments, ${dropped} flagged as hallucination`);
  return transcript;
}
