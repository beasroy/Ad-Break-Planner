// PROVISIONAL: endpoint contracts until API_SPEC.md lands.
import type { Job } from "./job";
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
