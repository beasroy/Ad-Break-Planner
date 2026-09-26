import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { STAGES, type BreaksResponse, type CreateJobResponse, type GetJobResponse, type Job, type ListJobsResponse } from "shared";
import { config } from "../config";
import { loadCatalogue } from "../catalogue/loader";
import { ARTIFACTS, exists, readJson, writeJson } from "../lib/artifacts";
import { hashFile } from "../lib/hash";
import { findSourceVideo, jobDir, runPipeline } from "../jobs/runner";
import { createJob, getJob, jobIdForHash, listJobs, removeJob } from "../jobs/store";
import type { Break, DebugReport } from "shared";
import { toTimeOffset, vastUrl } from "../xml/vmap";
import { creativeUrl } from "../xml/vast";

const uploadDir = path.join(config.dataDir, "_uploads");
const upload = multer({ dest: uploadDir, limits: { fileSize: config.maxUploadBytes } });

export const jobsRouter = Router();

/** Re-register jobs from disk on startup so pre-processed videos survive a restart. */
export async function restoreJobs() {
  await fs.mkdir(uploadDir, { recursive: true });
  for (const name of await fs.readdir(config.dataDir)) {
    const dir = path.join(config.dataDir, name);
    const metaPath = path.join(dir, "job.json");
    if (!(await exists(metaPath))) continue;
    const meta = await readJson<{ originalName: string; createdAt: string }>(metaPath);
    const job = createJob(name, meta.originalName);
    job.createdAt = meta.createdAt;
    if (await exists(path.join(dir, ARTIFACTS.debug))) {
      job.status = "done";
      for (const s of STAGES) job.stages[s] = { state: "cached" };
    }
  }
}

// PROVISIONAL
jobsRouter.post("/api/jobs", upload.single("video"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "multipart field 'video' is required" });
    const hash = await hashFile(req.file.path);
    const dir = jobDir(hash);
    await fs.mkdir(dir, { recursive: true });
    if (await findSourceVideo(dir)) {
      await fs.rm(req.file.path, { force: true });
    } else {
      const ext = path.extname(req.file.originalname).toLowerCase() || ".mp4";
      await fs.rename(req.file.path, path.join(dir, `source${ext}`));
    }

    let job = getJob(jobIdForHash(hash));
    if (!job || job.status !== "running") {
      job = createJob(hash, req.file.originalname);
      await writeJson(path.join(dir, "job.json"), { originalName: job.originalName, createdAt: job.createdAt });
      // Fire and forget; cached stages make a re-upload fast. The web app polls status.
      void runPipeline(job);
    }
    res.json({ job } satisfies CreateJobResponse);
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL
jobsRouter.get("/api/jobs", (_req, res) => {
  res.json({ jobs: listJobs() } satisfies ListJobsResponse);
});

const withJob = (id: string, res: any): Job | undefined => {
  const job = getJob(id);
  if (!job) res.status(404).json({ error: "job not found" });
  return job;
};

// PROVISIONAL: deletes the job and everything in its folder (source video, cached stages, outputs).
jobsRouter.delete("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = withJob(req.params.id, res);
    if (!job) return;
    // A running pipeline would keep writing into the folder we are removing.
    if (job.status === "running") return res.status(409).json({ error: "job is still processing" });
    removeJob(job.id);
    await fs.rm(jobDir(job.fileHash), { recursive: true, force: true });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

async function loadBreaks(job: Job): Promise<{ breaks: (Break & { brandName: string })[]; durationSec: number } | undefined> {
  const dir = jobDir(job.fileHash);
  const debugPath = path.join(dir, ARTIFACTS.debug);
  if (job.status !== "done" || !(await exists(debugPath))) return undefined;
  const debug = await readJson<DebugReport>(debugPath);
  const catalogue = await loadCatalogue(config.cataloguePath);
  const nameOf = (id: string) => catalogue.brands.find((b) => b.id === id)?.name ?? id;
  return { durationSec: debug.meta.durationSec, breaks: debug.breaks.map((b) => ({ ...b, brandName: nameOf(b.brandId) })) };
}

// PROVISIONAL
jobsRouter.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = withJob(req.params.id, res);
    if (!job) return;
    const loaded = await loadBreaks(job);
    const base = `${config.publicBaseUrl}/api/jobs/${job.id}`;
    const body: GetJobResponse = {
      job,
      results: loaded && {
        videoUrl: `${base}/video`,
        vmapUrl: `${base}/vmap.xml`,
        debugUrl: `${base}/debug.json`,
        breaksUrl: `${base}/breaks.json`,
        ...loaded,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL: the structured slot list (organisers accept this in place of VMAP).
jobsRouter.get("/api/jobs/:id/breaks.json", async (req, res, next) => {
  try {
    const job = withJob(req.params.id, res);
    if (!job) return;
    const loaded = await loadBreaks(job);
    if (!loaded) return res.status(409).json({ error: "job not finished" });
    const body: BreaksResponse = {
      jobId: job.id,
      durationSec: loaded.durationSec,
      breaks: loaded.breaks.map((b) => ({
        ...b,
        timeOffset: toTimeOffset(b.timeSec),
        vastUrl: vastUrl(config.publicBaseUrl, b),
        creativeUrl: creativeUrl(config.publicBaseUrl, b.brandId, b.creativeId),
      })),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL
for (const [route, file, type] of [
  ["vmap.xml", ARTIFACTS.vmap, "application/xml"],
  ["debug.json", ARTIFACTS.debug, "application/json"],
] as const) {
  jobsRouter.get(`/api/jobs/:id/${route}`, async (req, res) => {
    const job = withJob(req.params.id, res);
    if (!job) return;
    const p = path.join(jobDir(job.fileHash), file);
    if (!(await exists(p))) return res.status(409).json({ error: "job not finished" });
    res.type(type).sendFile(p);
  });
}

// PROVISIONAL: range-capable video stream for the player.
jobsRouter.get("/api/jobs/:id/video", async (req, res) => {
  const job = withJob(req.params.id, res);
  if (!job) return;
  const video = await findSourceVideo(jobDir(job.fileHash));
  if (!video) return res.status(404).json({ error: "video missing" });
  res.sendFile(video, { acceptRanges: true });
});

