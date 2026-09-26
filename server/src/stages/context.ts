import path from "node:path";
import type { Catalogue } from "shared";
import { config, type AppConfig } from "../config";

export interface StageContext {
  jobId: string;
  dir: string;
  videoPath: string;
  catalogue: Catalogue;
  config: AppConfig;
  /** Ignore cached artifacts for this run. */
  force: boolean;
  log: (msg: string) => void;
}

export const artifactPath = (ctx: StageContext, name: string) => path.join(ctx.dir, name);

export function makeContext(opts: {
  jobId: string;
  dir: string;
  videoPath: string;
  catalogue: Catalogue;
  force?: boolean;
  log?: (msg: string) => void;
}): StageContext {
  return {
    ...opts,
    config,
    force: opts.force ?? false,
    log: opts.log ?? ((m) => console.log(`[${opts.jobId}] ${m}`)),
  };
}
