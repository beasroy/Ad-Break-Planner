// Which job/attempt/stage a model call belongs to, carried implicitly through async code so the
// API clients can log every request without threading ids through every stage function.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelCall } from "shared";
import { maybeRepo } from "../db";

export interface CallContext {
  jobId?: string;
  attempt?: number;
  stage?: string;
}

const store = new AsyncLocalStorage<CallContext>();

export const withCallContext = <T>(ctx: CallContext, fn: () => T): T => store.run({ ...store.getStore(), ...ctx }, fn);

/** Records one provider request. Never throws: logging must not fail the pipeline. */
export function recordModelCall(c: Omit<ModelCall, "id" | "jobId" | "attempt" | "stage">) {
  const repo = maybeRepo();
  if (!repo) return;
  const ctx = store.getStore() ?? {};
  try {
    repo.recordModelCall({ ...c, jobId: ctx.jobId, attempt: ctx.attempt, stage: ctx.stage });
  } catch (err) {
    console.warn(`[audit] could not record model call: ${(err as Error).message}`);
  }
}
