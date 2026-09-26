// Stage 2: Whisper per chunk (parallel, raw responses cached per chunk), then merge
// onto one timeline and flag likely hallucinations. Flagged segments stay in the
// artifact with `dropped` set: they are hidden from the LLM but still block cuts.
import fs from "node:fs/promises";
import path from "node:path";
import type { AudioChunk, IngestArtifact, Interval, Segment, Signals, Thresholds, Transcript } from "shared";
import { ARTIFACTS, exists, readJson, writeJson } from "../lib/artifacts";
import { transcribe } from "../lib/openrouter";
import { mapLimit } from "../lib/pool";
import { artifactPath, type StageContext } from "./context";

export interface RawChunkResult {
  chunkIndex: number;
  raw: any;
}

/** Calls Whisper for every chunk that has no cached raw response. */
export async function transcribeChunks(ctx: StageContext, ingest: IngestArtifact): Promise<RawChunkResult[]> {
  const rawDir = artifactPath(ctx, "whisper");
  await fs.mkdir(rawDir, { recursive: true });
  let loggedFields = false;

  return mapLimit(ingest.chunks, ctx.config.openrouter.concurrency, async (chunk) => {
    const cached = path.join(rawDir, `chunk_${String(chunk.index).padStart(3, "0")}.json`);
    if (!ctx.force && (await exists(cached))) return { chunkIndex: chunk.index, raw: await readJson(cached) };

    const raw = await transcribe(chunk.file);
    if (!Array.isArray(raw?.segments)) {
      throw new Error(`Whisper returned no segments for chunk ${chunk.index}; keys: ${Object.keys(raw ?? {}).join(",")}`);
    }
    if (!loggedFields && raw.segments[0]) {
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

export function hallucinationReason(seg: Segment, silences: Interval[], t: Thresholds): string | undefined {
  if (!seg.text.trim()) return "empty text";
  const cov = silenceCoverage(seg, silences);
  if (cov >= t.hallucinationSilenceOverlap) return `${Math.round(cov * 100)}% inside silence`;
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
export function buildTranscript(
  results: RawChunkResult[],
  chunks: AudioChunk[],
  silences: Interval[],
  t: Thresholds,
): Transcript {
  const fields = new Set<string>();
  const merged: Omit<Segment, "id">[] = [];
  const sortedSilences = [...silences].sort((a, b) => a.start - b.start);

  for (const { chunkIndex, raw } of results) {
    const chunk = chunks.find((c) => c.index === chunkIndex);
    if (!chunk) throw new Error(`Unknown chunk ${chunkIndex}`);
    const chunkEnd = chunk.offsetSec + chunk.durationSec;
    for (const s of raw.segments ?? []) {
      Object.keys(s).forEach((k) => fields.add(k));
      const start = chunk.offsetSec + Number(s.start);
      const end = Math.min(chunk.offsetSec + Number(s.end), chunkEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      merged.push({
        start,
        end,
        text: String(s.text ?? "").trim(),
        chunkIndex,
        noSpeechProb: num(s.no_speech_prob),
        avgLogprob: num(s.avg_logprob),
        compressionRatio: num(s.compression_ratio),
      });
    }
  }

  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: Segment[] = merged.map((s, id) => {
    const seg: Segment = { id, ...s };
    const reason = hallucinationReason(seg, sortedSilences, t);
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
  if (!ctx.force && (await exists(out))) return readJson(out);
  const transcript = buildTranscript(raw, ingest.chunks, signals.silences, ctx.config.thresholds);
  await writeJson(out, transcript);
  const dropped = transcript.segments.filter((s) => s.dropped).length;
  ctx.log(`transcript: ${transcript.segments.length} segments, ${dropped} flagged as hallucination`);
  return transcript;
}
