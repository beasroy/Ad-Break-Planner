import fs from "node:fs/promises";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { config } from "./config";
import { assertFfmpegAvailable } from "./lib/ffmpeg";
import { loadCatalogue } from "./catalogue/loader";
import { initDb } from "./db";
import { createQueue } from "./jobs/queue";
import { runPipeline } from "./jobs/runner";
import { importLegacyJobs, jobsRouter, queueSignal } from "./routes/jobs";
import { adsRouter } from "./routes/ads";

async function main() {
  await assertFfmpegAvailable();
  if (!config.openrouter.apiKey) console.warn("WARNING: OPENROUTER_API_KEY is not set; AI stages will fail.");

  const catalogue = await loadCatalogue(config.cataloguePath);
  console.log(`Catalogue: ${catalogue.brands.length} brands, ${catalogue.negativeVocab.length} negative contexts`);

  await fs.mkdir(config.dataDir, { recursive: true });
  const repo = initDb(config.dbPath);
  console.log(`Database: ${config.dbPath}`);
  await importLegacyJobs();

  const queue = createQueue({ repo, run: runPipeline, config: config.queue });
  queueSignal.notify = queue.notify;
  queue.start();
  // On shutdown, hand running jobs back to the queue at once so the next start resumes them.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      const released = queue.stop();
      if (released.length) console.log(`Released ${released.length} running job(s) back to the queue`);
      process.exit(0);
    });
  }

  const app = express();
  app.use(cors());
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use(jobsRouter);
  app.use(adsRouter);

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(err?.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({ error: err?.message ?? "internal error" });
  };
  app.use(onError);

  app.listen(config.port, () => console.log(`Server on http://localhost:${config.port}`));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
