// Stage 2: transcribe each audio chunk with BOTH providers in parallel (raw responses
// cached per provider per chunk), then merge onto one timeline.
// - Deepgram nova-3: audio-aligned utterance timing → `speech` intervals, the hard walls for cuts.
// - Gemini (LLM): better Bengali/dialect text → the `segments` scene understanding reads.
// If one provider fails on a chunk the other covers it (Deepgram text, or LLM text without
// walls); if both fail the stage fails, because a hole could hide a sensitive scene.
import fs from "node:fs/promises";
import path from "node:path";
import type { AudioChunk, IngestArtifact, Interval, Segment, Signals, Thresholds, Transcript } from "shared";
import { ARTIFACTS, readKeyed, writeKeyed, exists, readJson, writeJson } from "../lib/artifacts";
import { transcribeDeepgram } from "../lib/deepgram";
import { hashJson } from "../lib/hash";
import { chatJson } from "../lib/openrouter";
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
  /** Raw Deepgram response, when that call succeeded. */
  deepgram?: any;
  /** Raw LLM response ({ utterances }), when that call succeeded. */
  llm?: any;
}

/** Bump when merge/filter logic changes so cached transcripts are rebuilt (raw chunk responses are reused). */
const TRANSCRIPT_BUILD_VERSION = 7;

const providerDirs = (ctx: StageContext) => ({
  deepgram: artifactPath(ctx, path.join("transcribe", `deepgram-${ctx.config.deepgram.model}`)),
  llm: artifactPath(
    ctx,
    path.join("transcribe", `llm-${ctx.config.openrouter.transcribeModel.replace(/[^a-z0-9.-]+/gi, "_")}-v${TRANSCRIBE_PROMPT_VERSION}`),
  ),
});

async function transcribeWithLlm(ctx: StageContext, chunk: AudioChunk) {
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
      ctx.log(`LLM transcribe chunk ${chunk.index} attempt ${attempt + 1} failed: ${lastErr}`);
    }
  }
  throw new Error(`LLM transcription failed for chunk ${chunk.index}: ${lastErr}`);
}

async function transcribeWithDeepgram(chunk: AudioChunk) {
  const raw = await transcribeDeepgram(chunk.file);
  if (!Array.isArray(raw?.results?.utterances)) throw new Error("no utterances in Deepgram response");
  return raw;
}

/** Cached per provider per chunk; only missing responses are fetched. */
async function cachedCall<T>(ctx: StageContext, dir: string, chunk: AudioChunk, fetch: () => Promise<T>): Promise<T> {
  const file = path.join(dir, `chunk_${String(chunk.index).padStart(3, "0")}.json`);
  if (!ctx.force && (await exists(file))) return readJson<T>(file);
  const raw = await fetch();
  await writeJson(file, raw);
  return raw;
}

export async function transcribeChunks(ctx: StageContext, ingest: IngestArtifact): Promise<RawChunkResult[]> {
  const dirs = providerDirs(ctx);
  await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));

  return mapLimit(ingest.chunks, ctx.config.openrouter.concurrency, async (chunk) => {
    const [dg, llm] = await Promise.allSettled([
      cachedCall(ctx, dirs.deepgram, chunk, () => transcribeWithDeepgram(chunk)),
      cachedCall(ctx, dirs.llm, chunk, () => transcribeWithLlm(ctx, chunk)),
    ]);
    if (dg.status === "rejected") ctx.log(`Deepgram failed on chunk ${chunk.index}: ${String(dg.reason?.message ?? dg.reason).slice(0, 200)}`);
    if (llm.status === "rejected") ctx.log(`LLM failed on chunk ${chunk.index}: ${String(llm.reason?.message ?? llm.reason).slice(0, 200)}`);
    if (dg.status === "rejected" && llm.status === "rejected") {
      throw new Error(`both transcribers failed for chunk ${chunk.index}`);
    }
    return {
      chunkIndex: chunk.index,
      deepgram: dg.status === "fulfilled" ? dg.value : undefined,
      llm: llm.status === "fulfilled" ? llm.value : undefined,
    };
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
 * Silence overlap only applies to audio-aligned (Deepgram) text segments: LLM timestamps can
 * drift by seconds, so the rule would throw away real dialogue.
 */
export function hallucinationReason(seg: Segment, silences: Interval[], t: Thresholds): string | undefined {
  if (!seg.text.trim()) return "empty text";
  if (seg.approxTiming) return undefined;
  const cov = silenceCoverage(seg, silences);
  if (cov >= t.hallucinationSilenceOverlap) return `${Math.round(cov * 100)}% inside silence`;
  return undefined;
}

type Piece = Omit<Segment, "id">;

const valid = (p: Piece) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start && !!p.text;

/** Pure: Deepgram utterances → absolute-time pieces, clamped to the chunk. */
export function deepgramPieces(raw: any, chunk: AudioChunk): Piece[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;
  return (raw?.results?.utterances ?? [])
    .map(
      (u: any): Piece => ({
        start: off + Math.max(0, Number(u.start)),
        end: Math.min(off + Number(u.end), chunkEnd),
        text: String(u.transcript ?? "").trim(),
        chunkIndex: chunk.index,
        source: "deepgram",
        confidence: typeof u.confidence === "number" ? u.confidence : undefined,
      }),
    )
    .filter(valid);
}

/**
 * Pure: Deepgram words → audio-aligned speech intervals. Each word is capped to `maxWordSec`
 * from its start, because Deepgram stretches a word's end across the pause that follows it.
 */
export function deepgramSpeech(raw: any, chunk: AudioChunk, maxWordSec: number): Interval[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;
  const out: Interval[] = [];
  for (const u of raw?.results?.utterances ?? []) {
    for (const w of u.words ?? []) {
      const start = off + Math.max(0, Number(w.start));
      const end = Math.min(off + Number(w.end), start + maxWordSec, chunkEnd);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) out.push({ start, end });
    }
  }
  return out;
}

/** Pure: LLM utterances → absolute-time pieces (approximate timing), clamped to the chunk. */
export function llmPieces(raw: any, chunk: AudioChunk): Piece[] {
  const off = chunk.offsetSec;
  const chunkEnd = off + chunk.durationSec;
  return (raw?.utterances ?? [])
    .map(
      (u: any): Piece => ({
        start: off + Math.max(0, Number(u.start)),
        end: Math.min(off + Number(u.end), chunkEnd),
        text: String(u.text ?? "").trim(),
        chunkIndex: chunk.index,
        source: "llm",
        approxTiming: true,
      }),
    )
    .filter(valid);
}

/**
 * Pure: per chunk, text segments come from the LLM when available (better dialect
 * understanding), else Deepgram; speech walls come from every Deepgram word (capped).
 */
export function buildTranscript(
  results: RawChunkResult[],
  chunks: AudioChunk[],
  silences: Interval[],
  t: Thresholds,
  maxWordSec: number,
): Transcript {
  const fields = new Set<string>();
  const providers: Record<string, number> = {};
  const text: Piece[] = [];
  const speech: Interval[] = [];
  const speechCoverage: Interval[] = [];
  const sortedSilences = [...silences].sort((a, b) => a.start - b.start);

  for (const r of results) {
    const chunk = chunks.find((c) => c.index === r.chunkIndex);
    if (!chunk) throw new Error(`Unknown chunk ${r.chunkIndex}`);
    const dg = r.deepgram ? deepgramPieces(r.deepgram, chunk) : [];
    const lm = r.llm ? llmPieces(r.llm, chunk) : [];
    if (r.deepgram) {
      providers.deepgram = (providers.deepgram ?? 0) + 1;
      for (const u of r.deepgram.results?.utterances ?? []) Object.keys(u).forEach((k) => fields.add(`deepgram.${k}`));
    }
    if (r.llm) {
      providers.llm = (providers.llm ?? 0) + 1;
      for (const u of r.llm.utterances ?? []) Object.keys(u).forEach((k) => fields.add(`llm.${k}`));
    }
    if (r.deepgram) {
      speech.push(...deepgramSpeech(r.deepgram, chunk, maxWordSec));
      speechCoverage.push({ start: chunk.offsetSec, end: chunk.offsetSec + chunk.durationSec });
    }
    text.push(...(r.llm ? lm : dg));
  }

  text.sort((a, b) => a.start - b.start || a.end - b.end);
  speech.sort((a, b) => a.start - b.start);
  const segments: Segment[] = text.map((s, id) => {
    const seg: Segment = { id, ...s };
    const reason = hallucinationReason(seg, sortedSilences, t);
    return reason ? { ...seg, dropped: { reason } } : seg;
  });

  const chunkSeams = chunks.slice(1).map((c) => c.offsetSec);
  speechCoverage.sort((a, b) => a.start - b.start);
  return { segments, speech, speechCoverage, chunkSeams, rawFieldsSeen: [...fields].sort(), providers };
}

export async function runTranscribe(
  ctx: StageContext,
  ingest: IngestArtifact,
  raw: RawChunkResult[],
  signals: Signals,
): Promise<Transcript> {
  const out = artifactPath(ctx, ARTIFACTS.transcript);
  const key = hashJson({
    v: TRANSCRIPT_BUILD_VERSION,
    dirs: providerDirs(ctx),
    t: ctx.config.thresholds,
    w: ctx.config.deepgram.maxWordSec,
    c: ingest.chunks.length,
    r: raw.map((r) => [!!r.deepgram, !!r.llm]),
  });
  const cached = ctx.force ? undefined : await readKeyed<Transcript>(out, key);
  if (cached) return cached;
  const transcript = buildTranscript(raw, ingest.chunks, signals.silences, ctx.config.thresholds, ctx.config.deepgram.maxWordSec);
  await writeKeyed(out, key, transcript);
  const dropped = transcript.segments.filter((s) => s.dropped).length;
  ctx.log(
    `transcript: ${transcript.segments.length} text segments, ${transcript.speech.length} speech intervals ` +
      `(${JSON.stringify(transcript.providers)}), ${dropped} flagged as hallucination`,
  );
  return transcript;
}
