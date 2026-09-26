// PROVISIONAL: endpoint contracts until API_SPEC.md lands.
import type { AuditEvent, Job, JobAttempt, ModelCall, ModelUsage } from "./job";
import type { Break } from "./pipeline";

/** POST /api/jobs  (multipart, field "video") */
export interface CreateJobResponse {
  job: Job;
}

/** GET /api/jobs */
export interface ListJobsResponse {
  jobs: Job[];
}

/** GET /api/jobs/:id */
export interface GetJobResponse {
  job: Job;
  /** Present once the outputs stage is done. */
  results?: JobResults;
}

export interface JobResults {
  videoUrl: string;
  vmapUrl: string;
  debugUrl: string;
  breaksUrl: string;
  durationSec: number;
  breaks: (Break & { brandName: string })[];
}

/** GET /api/jobs/:id/breaks.json — the structured slot list (VMAP alternative the organisers accept). */
export interface BreaksResponse {
  jobId: string;
  durationSec: number;
  breaks: (Break & { brandName: string; timeOffset: string; vastUrl: string; creativeUrl: string })[];
}

/** GET /api/jobs/:id/audit */
export interface JobAuditResponse {
  jobId: string;
  attempts: JobAttempt[];
  events: AuditEvent[];
  usage: ModelUsage[];
  totals: { calls: number; errors: number; costUsd: number };
  /** Most recent calls first. */
  modelCalls: ModelCall[];
}

/**
 * GET /api/events[?jobId=]  (Server-Sent Events). On connect: `snapshot` with the current
 * jobs (or the one job), then `job` whenever a job changes and `deleted` when one is removed.
 * A reconnect gets a fresh snapshot, so nothing missed while offline is lost.
 */
export type JobStreamEvent =
  | { type: "snapshot"; jobs: Job[] }
  | { type: "job"; job: Job }
  | { type: "deleted"; id: string };

/** GET /api/brands */
export interface BrandSummary {
  id: string;
  name: string;
  category: string;
  targetContexts: string[];
  negativeContexts: string[];
  headline?: string;
  tagline?: string;
  creatives: { id: string; durationSec: number; language: string; url: string }[];
}

export interface ListBrandsResponse {
  brands: BrandSummary[];
  /** Hash of the current catalogue; a job processed with a different one is stale. */
  catalogueHash: string;
}

/** POST /api/brands, DELETE /api/brands/:id: the catalogue change and the jobs re-queued because of it. */
export interface BrandChangeResponse {
  brand?: BrandSummary;
  requeuedJobs: string[];
  /** Set when a creative could not be generated and a plain placeholder was used instead. */
  warning?: string;
}
