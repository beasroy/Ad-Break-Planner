import { STAGES, type Job, type StageName, type StageStatus } from "shared";

const jobs = new Map<string, Job>();

export const jobIdForHash = (hash: string) => hash.slice(0, 16);

export function createJob(fileHash: string, originalName: string): Job {
  const job: Job = {
    id: jobIdForHash(fileHash),
    fileHash,
    originalName,
    createdAt: new Date().toISOString(),
    status: "queued",
    stages: Object.fromEntries(STAGES.map((s) => [s, { state: "pending" }])) as Record<StageName, StageStatus>,
  };
  jobs.set(job.id, job);
  return job;
}

export const getJob = (id: string) => jobs.get(id);
export const listJobs = () => [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function setStage(job: Job, stage: StageName, patch: Partial<StageStatus>) {
  job.stages[stage] = { ...job.stages[stage], ...patch };
}
