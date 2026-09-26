// The live catalogue's hash, re-read only when the file changes on disk (hand edits included).
import fs from "node:fs";
import path from "node:path";
import type { Job } from "shared";
import { config } from "../config";
import { parseCatalogue } from "./loader";

let cached: { mtimeMs: number; hash: string } | undefined;

export function currentCatalogueHash(file = config.cataloguePath): string | undefined {
  try {
    const { mtimeMs } = fs.statSync(file);
    if (cached?.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, hash: parseCatalogue(JSON.parse(fs.readFileSync(file, "utf8")), path.dirname(file)).hash };
    }
    return cached.hash;
  } catch {
    return undefined; // an unreadable catalogue surfaces when a job runs; never break job listings over it
  }
}

/** Marks a finished job whose breaks were chosen with a different catalogue than the current one. */
export function withStaleFlag(job: Job): Job {
  const now = currentCatalogueHash();
  return { ...job, catalogueStale: job.status === "done" && !!now && !!job.catalogueHash && job.catalogueHash !== now };
}
