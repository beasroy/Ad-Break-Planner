// Run a single stage against a video's cached upstream artifacts.
// Usage:
//   npm run stage -w server -- add <path/to/video>           copy a video into /data/{hash}/ and print its id
//   npm run stage -w server -- <stage|all> <hash-or-prefix> [--force]
// Stages: ingest transcribe signals scenes candidates match select outputs
import fs from "node:fs/promises";
import path from "node:path";
import type { Candidate, IngestArtifact, MatchedCandidate, Scene, Signals, Transcript } from "shared";
import { config } from "../src/config";
import { openCatalogue } from "../src/catalogue/store";
import { ARTIFACTS, exists, readJson, writeJson } from "../src/lib/artifacts";
import { hashFile } from "../src/lib/hash";
import { findSourceVideo, runPipeline } from "../src/jobs/runner";
import { makeContext } from "../src/stages/context";
import { runIngest } from "../src/stages/ingest";
import { runSignals } from "../src/stages/signals";
import { runTranscribe, transcribeChunks } from "../src/stages/transcribe";
import { runScenes } from "../src/stages/scenes";
import { runCandidates } from "../src/stages/candidates";
import { runMatch } from "../src/stages/match";
import { runSelect } from "../src/stages/select";
import { runOutputs } from "../src/stages/outputs";

const [stage, target, ...flags] = process.argv.slice(2);
const force = flags.includes("--force");

if (stage === "add") {
  const hash = await hashFile(target);
  const dir = path.join(config.dataDir, hash);
  await fs.mkdir(dir, { recursive: true });
  if (!(await findSourceVideo(dir))) await fs.copyFile(target, path.join(dir, `source${path.extname(target) || ".mp4"}`));
  if (!(await exists(path.join(dir, "job.json")))) {
    await writeJson(path.join(dir, "job.json"), { originalName: path.basename(target), createdAt: new Date().toISOString() });
  }
  console.log(hash);
  process.exit(0);
}

const hash = (await fs.readdir(config.dataDir)).find((d) => d.startsWith(target ?? "\0"));
if (!stage || !hash) {
  console.error("usage: npm run stage -w server -- <stage|all> <hash-prefix> [--force]   |   npm run stage -w server -- add <video>");
  process.exit(1);
}
const dir = path.join(config.dataDir, hash);
const videoPath = (await findSourceVideo(dir))!;
const catalogue = await openCatalogue();
const ctx = makeContext({ jobId: hash.slice(0, 16), dir, videoPath, catalogue, force });
const need = async <T>(name: string): Promise<T> => {
  const p = path.join(dir, name);
  if (!(await exists(p))) throw new Error(`missing upstream artifact ${name}; run the earlier stage first`);
  const v = await readJson<any>(p);
  return (v && typeof v === "object" && "inputsKey" in v ? v.data : v) as T;
};

const t0 = Date.now();
switch (stage) {
  case "all": {
    // CLI run: straight through the pipeline, no queue or database.
    const result = await runPipeline(
      { id: hash.slice(0, 16), fileHash: hash },
      { onStage: (s, st) => st.state !== "running" && console.log(`${s}: ${st.state}${st.note ? ` (${st.note})` : ""}`) },
      { force },
    );
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case "ingest":
    await runIngest(ctx);
    break;
  case "signals":
    await runSignals(ctx, await need<IngestArtifact>(ARTIFACTS.ingest));
    break;
  case "transcribe": {
    const ingest = await need<IngestArtifact>(ARTIFACTS.ingest);
    const raw = await transcribeChunks(ctx, ingest);
    await runTranscribe(ctx, ingest, raw, await need<Signals>(ARTIFACTS.signals));
    break;
  }
  case "scenes":
    await runScenes(ctx, await need<Transcript>(ARTIFACTS.transcript));
    break;
  case "candidates":
    await runCandidates(
      ctx,
      await need<Scene[]>(ARTIFACTS.scenes),
      await need<Transcript>(ARTIFACTS.transcript),
      await need<Signals>(ARTIFACTS.signals),
      await need<IngestArtifact>(ARTIFACTS.ingest),
    );
    break;
  case "match":
    await runMatch(
      ctx,
      await need<Candidate[]>(ARTIFACTS.candidates),
      await need<Scene[]>(ARTIFACTS.scenes),
      await need<IngestArtifact>(ARTIFACTS.ingest),
      (await need<Transcript>(ARTIFACTS.transcript)).speech ?? [],
    );
    break;
  case "select":
    await runSelect(ctx, await need<(Candidate | MatchedCandidate)[]>(ARTIFACTS.matches), (await need<IngestArtifact>(ARTIFACTS.ingest)).meta.durationSec);
    break;
  case "outputs":
    await runOutputs(
      ctx,
      hash,
      await need<IngestArtifact>(ARTIFACTS.ingest),
      await need<Transcript>(ARTIFACTS.transcript),
      await need<Scene[]>(ARTIFACTS.scenes),
      await need<(Candidate | MatchedCandidate)[]>(ARTIFACTS.matches),
      await need(ARTIFACTS.breaks),
    );
    break;
  default:
    console.error(`unknown stage ${stage}`);
    process.exit(1);
}
console.log(`${stage} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
