import fs from "node:fs";
import path from "node:path";
import { publishJobEvent } from "../jobs/events";
import { createRepo, openDb, type Repo } from "./repo";

export type { Repo, Requester } from "./repo";

let repo: Repo | undefined;

/** Opens (and migrates) the database once at server start. */
export function initDb(file: string): Repo {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Every committed job change is pushed to live-update subscribers.
  const r: Repo = createRepo(openDb(file), undefined, (ids) => {
    for (const id of ids) {
      const job = r.getJob(id);
      publishJobEvent(job ? { type: "job", job } : { type: "deleted", id });
    }
  });
  repo = r;
  return r;
}

/** The app's repository; undefined in scripts and tests that never called initDb. */
export const maybeRepo = () => repo;

export function getRepo(): Repo {
  if (!repo) throw new Error("database not initialised; call initDb() first");
  return repo;
}
