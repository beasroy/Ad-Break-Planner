import fsSync from "node:fs";
import fs from "node:fs/promises";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { config } from "./config";
import { assertFfmpegAvailable } from "./lib/ffmpeg";
import { currentCatalogueHash, loadCatalogue } from "./catalogue/store";
import { initDb } from "./db";
import { createQueue } from "./jobs/queue";
import { runPipeline } from "./jobs/runner";
import { importLegacyJobs, jobsRouter, queueSignal } from "./routes/jobs";
import { adsRouter } from "./routes/ads";
import { brandsRouter } from "./routes/brands";

async function main() {
  await assertFfmpegAvailable();
  if (!config.openrouter.apiKey) console.warn("WARNING: OPENROUTER_API_KEY is not set; AI stages will fail.");

  await fs.mkdir(config.dataDir, { recursive: true });
  const repo = initDb(config.dbPath);
  console.log(`Database: ${config.dbPath}`);
  const catalogue = await loadCatalogue();
  console.log(`Catalogue: ${catalogue.brands.length} brands, ${catalogue.negativeVocab.length} negative contexts`);
  await importLegacyJobs();

  const queue = createQueue({ repo, run: runPipeline, config: config.queue, currentCatalogueHash });
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
  // Deleting data/ while the server runs leaves it writing to a database that no longer exists on
  // disk (lost at the next restart). Say so plainly instead of silently losing work.
  app.use((_req, res, next) => {
    if (fsSync.existsSync(config.dbPath)) return next();
    res.status(503).json({ error: "The data folder was deleted while the server was running. Restart the server." });
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use(jobsRouter);
  app.use(adsRouter);
  app.use(brandsRouter);

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
