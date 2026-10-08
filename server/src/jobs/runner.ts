import fs from "node:fs/promises";
import path from "node:path";
import type { StageName, StageStatus } from "shared";
import { config } from "../config";
import { loadCatalogue } from "../catalogue/store";
import { ARTIFACTS } from "../lib/artifacts";
import { withCallContext } from "../lib/callContext";
import { PermanentError } from "../lib/errors";
import { makeContext, type StageContext } from "../stages/context";
import { runIngest } from "../stages/ingest";
import { runOutputs } from "../stages/outputs";
import { runPlacement } from "../stages/placement";
import { runSignals } from "../stages/signals";
import { runTranscribe, transcribeChunks } from "../stages/transcribe";

export const jobDir = (fileHash: string) => path.join(config.dataDir, fileHash);

export async function findSourceVideo(dir: string): Promise<string | undefined> {
  const f = (await fs.readdir(dir).catch(() => [] as string[])).find((n) => n.startsWith("source."));
  return f ? path.join(dir, f) : undefined;
}

/** Thrown at a stage boundary once the attempt has run longer than allowed. */
export class AttemptTimeoutError extends Error {
  override name = "AttemptTimeoutError";
}

export interface PipelineHooks {
  onStage: (stage: StageName, status: StageStatus) => void;
  /** Aborted when the attempt times out; checked before each stage starts. */
  signal?: AbortSignal;
}

export interface PipelineResult {
  durationSec: number;
  breakCount: number;
  catalogueHash: string;
}

/** The stage a pipeline error came from, for the attempt record. */
export class StageError extends Error {
  constructor(public stage: StageName, public cause: unknown) {
    super((cause as Error)?.message ?? String(cause));
    this.name = "StageError";
  }
}

/**
 * Runs every stage in order and throws on failure (the queue decides whether to retry).
 * Stages reuse cached artifacts, so a retry or re-run resumes where the last one stopped.
 */
export async function runPipeline(
  job: { id: string; fileHash: string },
  hooks: PipelineHooks,
  opts: { force?: boolean } = {},
): Promise<PipelineResult> {
  const dir = jobDir(job.fileHash);
  // A stage counts as "cached" when its artifact existed beforehand and was not rewritten.
  const artifactFor: Partial<Record<StageName, string>> = {
    ingest: ARTIFACTS.ingest,
    signals: ARTIFACTS.signals,
    placement: ARTIFACTS.placement,
  };
  const mtime = async (name: StageName) => {
    const art = artifactFor[name];
    return art ? (await fs.stat(path.join(dir, art)).catch(() => undefined))?.mtimeMs : undefined;
  };

  async function stage<T>(name: StageName, fn: () => Promise<T>): Promise<T> {
    if (hooks.signal?.aborted) throw new StageError(name, hooks.signal.reason);
    const before = await mtime(name);
    const startedAt = new Date().toISOString();
    hooks.onStage(name, { state: "running", startedAt });
    try {
      const r = await withCallContext({ stage: name }, fn);
      const cached = before !== undefined && before === (await mtime(name));
      hooks.onStage(name, { state: cached ? "cached" : "done", startedAt, finishedAt: new Date().toISOString() });
      return r;
    } catch (err) {
      hooks.onStage(name, { state: "error", startedAt, finishedAt: new Date().toISOString(), note: (err as Error).message });
      throw new StageError(name, err);
    }
  }

  const videoPath = await findSourceVideo(dir);
  if (!videoPath) throw new PermanentError(`source video missing in ${dir}`);
  // Catalogue is re-read for every run so a changed/added brand needs no restart.
  const catalogue = await loadCatalogue();
  const ctx: StageContext = makeContext({ jobId: job.id, dir, videoPath, catalogue, force: opts.force });

  const ingest = await stage("ingest", () => runIngest(ctx));
  // Transcription and ffmpeg signals run side by side; the transcript filter needs both.
  const [raw, signals] = await Promise.all([
    stage("transcribe", () => transcribeChunks(ctx, ingest)),
    stage("signals", () => runSignals(ctx, ingest)),
  ]);
  const transcript = await runTranscribe(ctx, ingest, raw, signals);

  // One LLM call per transcription chunk picks line + brand; code finds the cut, enforces the
  // safety rules and schedules the best combination (see stages/placement.ts).
  const plan = await stage("placement", () => runPlacement(ctx, ingest, transcript, signals));
  await stage("outputs", () => runOutputs(ctx, job.fileHash, ingest, transcript, plan));
  return { durationSec: ingest.meta.durationSec, breakCount: plan.breaks.length, catalogueHash: catalogue.hash };
}
