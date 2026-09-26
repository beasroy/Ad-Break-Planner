import fs from "node:fs/promises";
import path from "node:path";
import type { Job, StageName } from "shared";
import { config } from "../config";
import { loadCatalogue } from "../catalogue/loader";
import { ARTIFACTS } from "../lib/artifacts";
import { makeContext, type StageContext } from "../stages/context";
import { runCandidates } from "../stages/candidates";
import { runIngest } from "../stages/ingest";
import { runMatch } from "../stages/match";
import { runOutputs } from "../stages/outputs";
import { runScenes } from "../stages/scenes";
import { runSelect } from "../stages/select";
import { runSignals } from "../stages/signals";
import { runTranscribe, transcribeChunks } from "../stages/transcribe";
import { setStage } from "./store";

export const jobDir = (fileHash: string) => path.join(config.dataDir, fileHash);

export async function findSourceVideo(dir: string): Promise<string | undefined> {
  const f = (await fs.readdir(dir).catch(() => [] as string[])).find((n) => n.startsWith("source."));
  return f ? path.join(dir, f) : undefined;
}

const running = new Set<string>();

/** Runs every stage in order. Stages reuse cached artifacts, so re-running a finished job is cheap. */
export async function runPipeline(job: Job, opts: { force?: boolean } = {}): Promise<void> {
  if (running.has(job.id)) return;
  running.add(job.id);
  job.status = "running";
  job.error = undefined;

  const dir = jobDir(job.fileHash);
  // A stage counts as "cached" when its artifact existed beforehand and was not rewritten.
  const artifactFor: Partial<Record<StageName, string>> = {
    ingest: ARTIFACTS.ingest,
    signals: ARTIFACTS.signals,
    scenes: ARTIFACTS.scenes,
    candidates: ARTIFACTS.candidates,
    match: ARTIFACTS.matches,
    select: ARTIFACTS.breaks,
  };
  const mtime = async (name: StageName) => {
    const art = artifactFor[name];
    return art ? (await fs.stat(path.join(dir, art)).catch(() => undefined))?.mtimeMs : undefined;
  };

  async function stage<T>(name: StageName, fn: () => Promise<T>): Promise<T> {
    const before = await mtime(name);
    setStage(job, name, { state: "running", startedAt: new Date().toISOString(), note: undefined });
    try {
      const r = await fn();
      const cached = before !== undefined && before === (await mtime(name));
      setStage(job, name, { state: cached ? "cached" : "done", finishedAt: new Date().toISOString() });
      return r;
    } catch (err) {
      setStage(job, name, { state: "error", finishedAt: new Date().toISOString(), note: (err as Error).message });
      throw err;
    }
  }

  try {
    const videoPath = await findSourceVideo(dir);
    if (!videoPath) throw new Error(`source video missing in ${dir}`);
    // Catalogue is re-read for every run so a changed/added brand needs no restart.
    const catalogue = await loadCatalogue(config.cataloguePath);
    const ctx: StageContext = makeContext({ jobId: job.id, dir, videoPath, catalogue, force: opts.force });

    const ingest = await stage("ingest", () => runIngest(ctx));
    // Transcription and ffmpeg signals run side by side; the transcript filter needs both.
    const [raw, signals] = await Promise.all([
      stage("transcribe", () => transcribeChunks(ctx, ingest)),
      stage("signals", () => runSignals(ctx, ingest)),
    ]);
    const transcript = await runTranscribe(ctx, ingest, raw, signals);
    const scenes = await stage("scenes", () => runScenes(ctx, transcript));
    const candidates = await stage("candidates", () => runCandidates(ctx, scenes, transcript, signals));
    const matched = await stage("match", () => runMatch(ctx, candidates, scenes));
    const selection = await stage("select", () => runSelect(ctx, matched, ingest.meta.durationSec));
    await stage("outputs", () => runOutputs(ctx, job.fileHash, ingest, transcript, scenes, matched, selection));
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message;
    console.error(`[${job.id}] pipeline failed:`, err);
  } finally {
    running.delete(job.id);
  }
}
