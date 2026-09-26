import { STAGES, type Job, type StageName } from "shared";

export const STAGE_LABELS: Record<StageName, string> = {
  ingest: "Extract audio",
  transcribe: "Transcribe dialogue",
  signals: "Detect silences & shot cuts",
  scenes: "Understand scenes",
  candidates: "Find safe cut points",
  match: "Match brands",
  select: "Apply pacing rules",
  outputs: "Write VMAP & report",
};

/** What a running job is doing now, e.g. { label: "Transcribe dialogue", step: 2, total: 8 }. */
export function currentStage(job: Job): { label: string; step: number; total: number } | undefined {
  const i = STAGES.findIndex((s) => job.stages[s]?.state === "running");
  if (i < 0) return undefined;
  const others = STAGES.filter((s, j) => j !== i && job.stages[s]?.state === "running").map((s) => STAGE_LABELS[s].toLowerCase());
  return { label: [STAGE_LABELS[STAGES[i]], ...others].join(" + "), step: i + 1, total: STAGES.length };
}
