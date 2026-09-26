// Durable job queue: jobs are rows in SQLite, so a restart loses nothing. A worker loop claims
// due jobs (one transaction, so never twice), runs the pipeline, then marks the attempt done or
// failed. Failures are retried with exponential backoff unless the error is permanent; each
// retry resumes from cached stages. Heartbeats let a restarted server recover jobs a dead
// process was holding.
import os from "node:os";
import type { Repo } from "../db/repo";
import { withCallContext } from "../lib/callContext";
import { PermanentError } from "../lib/errors";
import { AttemptTimeoutError, StageError, type PipelineHooks, type PipelineResult } from "./runner";

export interface QueueConfig {
  concurrency: number;
  pollMs: number;
  maxAttempts: number;
  backoffBaseSec: number;
  backoffMaxSec: number;
  heartbeatSec: number;
  staleAfterSec: number;
  attemptTimeoutSec: number;
}

export type RunFn = (job: { id: string; fileHash: string }, hooks: PipelineHooks) => Promise<PipelineResult>;

/** Pure: delay before retrying after failed attempt n (1-based): base × 4^(n−1), capped. */
export function retryDelaySec(attempt: number, q: Pick<QueueConfig, "backoffBaseSec" | "backoffMaxSec">): number {
  return Math.min(q.backoffMaxSec, q.backoffBaseSec * 4 ** Math.max(0, attempt - 1));
}

/** Pure: unwraps the stage and root cause of a pipeline error and decides whether to retry it. */
export function classifyError(err: unknown): { message: string; stage?: string; retryable: boolean } {
  const stage = err instanceof StageError ? err.stage : undefined;
  const cause = err instanceof StageError ? err.cause : err;
  const message = cause instanceof Error ? `${cause.name === "Error" ? "" : `${cause.name}: `}${cause.message}` : String(cause);
  return { message, stage, retryable: !(cause instanceof PermanentError) };
}

export function createQueue(opts: { repo: Repo; run: RunFn; config: QueueConfig; workerId?: string }) {
  const { repo, run, config: q } = opts;
  const workerId = opts.workerId ?? `${os.hostname()}:${process.pid}`;
  const active = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let ticking = false;

  async function runAttempt(job: { id: string; fileHash: string; attempt: number }) {
    const heartbeat = setInterval(() => repo.heartbeat(job.id, workerId), q.heartbeatSec * 1000);
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new AttemptTimeoutError(`attempt exceeded ${q.attemptTimeoutSec}s`)),
      q.attemptTimeoutSec * 1000,
    );
    console.log(`[queue] ${job.id} attempt ${job.attempt} started`);
    try {
      const result = await withCallContext({ jobId: job.id, attempt: job.attempt }, () =>
        run(job, {
          signal: abort.signal,
          onStage: (stage, status) => {
            repo.setStage(job.id, job.attempt, stage, status);
            repo.heartbeat(job.id, workerId);
          },
        }),
      );
      repo.succeed(job.id, workerId, job.attempt, result);
      console.log(`[queue] ${job.id} attempt ${job.attempt} succeeded (${result.breakCount} breaks)`);
    } catch (err) {
      const e = classifyError(err);
      const outcome = repo.fail(job.id, workerId, job.attempt, {
        error: e.message,
        stage: e.stage,
        retryable: e.retryable,
        retryDelaySec: retryDelaySec(job.attempt, q),
      });
      console.error(`[queue] ${job.id} attempt ${job.attempt} failed at ${e.stage ?? "?"} → ${outcome}: ${e.message.slice(0, 300)}`);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }

  /** One scheduling pass: recover dead workers' jobs, then fill free slots with due jobs. */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const recovered = repo.recoverStale(q.staleAfterSec, (n) => retryDelaySec(n, q));
      if (recovered.length) console.warn(`[queue] recovered interrupted jobs: ${recovered.join(", ")}`);
      while (running && active.size < q.concurrency) {
        const job = repo.claimNext(workerId);
        if (!job) break;
        const p = runAttempt(job).finally(() => {
          active.delete(job.id);
          notify();
        });
        active.set(job.id, p);
      }
    } catch (err) {
      console.error("[queue] scheduling error:", err);
    } finally {
      ticking = false;
    }
  }

  function schedule(ms: number) {
    clearTimeout(timer);
    if (running) timer = setTimeout(() => void tick().then(() => schedule(q.pollMs)), ms);
  }

  /** Wake the loop now (after an upload or retry) instead of at the next poll. */
  function notify() {
    schedule(0);
  }

  return {
    workerId,
    tick,
    notify,
    start() {
      running = true;
      console.log(`[queue] worker ${workerId} started (concurrency ${q.concurrency})`);
      notify();
    },
    /** Stop claiming work and hand in-flight jobs back to the queue (for a clean shutdown). */
    stop() {
      running = false;
      clearTimeout(timer);
      return repo.recoverStale(0, () => 5, workerId);
    },
    /** Resolves when every in-flight attempt has finished (tests). */
    idle: () => Promise.all(active.values()).then(() => undefined),
    activeCount: () => active.size,
  };
}
