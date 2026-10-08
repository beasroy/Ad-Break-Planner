import fs from "node:fs/promises";
import path from "node:path";

export const ARTIFACTS = {
  ingest: "ingest.json",
  transcript: "transcript.json",
  signals: "signals.json",
  programme: "programme.json",
  placement: "placement.json",
  vmap: "vmap.xml",
  debug: "debug.json",
} as const;

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}

/** Write via temp file + rename so a crash never leaves a half-written artifact that later counts as cached. */
export async function writeFileAtomic(p: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

export const writeJson = (p: string, data: unknown) => writeFileAtomic(p, JSON.stringify(data, null, 2));

/** Appends one line of JSON to a log file, creating its directory if needed. */
export async function appendJsonl(p: string, entry: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, `${JSON.stringify(entry)}\n`);
}

/**
 * Artifacts that depend on inputs other than the video (catalogue, config) carry an
 * `inputsKey`; a cached artifact is reused only if its key still matches.
 */
export interface Keyed<T> {
  inputsKey: string;
  data: T;
}

export async function readKeyed<T>(p: string, inputsKey: string): Promise<T | undefined> {
  if (!(await exists(p))) return undefined;
  const k = await readJson<Keyed<T>>(p);
  return k.inputsKey === inputsKey ? k.data : undefined;
}

export const writeKeyed = <T>(p: string, inputsKey: string, data: T) => writeJson(p, { inputsKey, data });
