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

export interface Job {
  /** Derived from the file hash, so a re-upload maps to the same job and artifacts. */
  id: string;
  fileHash: string;
  originalName: string;
  createdAt: string;
  status: "queued" | "running" | "done" | "error";
  stages: Record<StageName, StageStatus>;
  error?: string;
}
