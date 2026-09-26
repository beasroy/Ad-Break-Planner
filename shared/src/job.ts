export const STAGES = [
  "ingest",
  "transcribe",
  "signals",
  "scenes",
  "candidates",
  "match",
  "select",
  "outputs",
] as const;

export type StageName = (typeof STAGES)[number];
export type StageState = "pending" | "running" | "done" | "cached" | "error";

export interface StageStatus {
  state: StageState;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
}

/** queued: waiting for a worker. retrying: failed, next attempt scheduled at nextRunAt. */
export type JobStatus = "queued" | "running" | "retrying" | "done" | "error";

export interface Job {
  /** Derived from the file hash, so a re-upload maps to the same job and artifacts. */
  id: string;
  fileHash: string;
  originalName: string;
  createdAt: string;
  updatedAt?: string;
  status: JobStatus;
  stages: Record<StageName, StageStatus>;
  error?: string;
  /** Attempts made so far, across every run of this job. */
  attempts?: number;
  /** The job fails for good once attempts reaches this. */
  maxAttempts?: number;
  /** When a queued or retrying job becomes due. */
  nextRunAt?: string;
  startedAt?: string;
  finishedAt?: string;
  sizeBytes?: number;
  durationSec?: number;
  breakCount?: number;
  /** Hash of the brand catalogue the job was last processed with. */
  catalogueHash?: string;
  /** Processed with a different brand catalogue than the current one: re-run before trusting its breaks. */
  catalogueStale?: boolean;
}

export type AuditActor = "api" | "worker" | "system";

/** Append-only record of everything that happened to a job. */
export interface AuditEvent {
  id: number;
  jobId: string;
  at: string;
  actor: AuditActor;
  type: string;
  attempt?: number;
  ip?: string;
  userAgent?: string;
  detail?: Record<string, unknown>;
}

export interface JobAttempt {
  attempt: number;
  workerId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  errorStage?: string;
  retryable?: boolean;
}

/** One HTTP request to a model provider (each retry is its own row). */
export interface ModelCall {
  id: number;
  jobId?: string;
  attempt?: number;
  stage?: string;
  provider: "openrouter" | "deepgram";
  model: string;
  label?: string;
  startedAt: string;
  latencyMs: number;
  ok: boolean;
  httpStatus?: number;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  audioSec?: number;
  costUsd?: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  calls: number;
  errors: number;
  totalLatencyMs: number;
  costUsd: number;
  audioSec: number;
}
