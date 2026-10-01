// Run only the LLM placement stage against a video's cached upstream artifacts (ingest, transcript,
// signals), so a prompt or logic change can be tried without the full pipeline.
// Only the LLM calls cost money: one placement call for EVERY chunk with dialogue (they run in
// parallel and independently, so none can be skipped upfront for being close to another), plus one
// cached episode summary, both on the reasoning model (Luna). If a scheduled cut is ambiguous to the
// free voice detector, the verification step also calls the transcribe model (Gemini) a couple of
// times per accepted ad to confirm nobody speaks.
// To test the placement prompt only, on Luna alone, turn that check off for this run:
//   LISTEN_CHECK_CUTS=false npm run placement -w server -- <hash-prefix>
//   npm run placement -w server -- <hash-prefix> [--cached]
// Results go to data/<hash>/playground/ (placement.json, placement-llm.jsonl, programme.json), never over the app's own
// placement.json, so the next real run is not invalidated. Every run calls the model again unless --cached.
import fs from "node:fs/promises";
import path from "node:path";
import type { IngestArtifact, Signals, Transcript } from "shared";
import { config } from "../src/config";
import { openCatalogue } from "../src/catalogue/store";
import { ARTIFACTS, exists, readJson } from "../src/lib/artifacts";
import { findSourceVideo } from "../src/jobs/runner";
import { makeContext } from "../src/stages/context";
import { runPlacement } from "../src/stages/placement";

const [target, ...flags] = process.argv.slice(2);
const hash = (await fs.readdir(config.dataDir)).find((d) => target && d.startsWith(target));
if (!hash) {
  console.error("usage: npm run placement -w server -- <hash-prefix> [--cached]");
  console.error(`videos in ${config.dataDir}:\n  ${(await fs.readdir(config.dataDir)).filter((d) => !d.startsWith("_") && !d.includes(".")).join("\n  ")}`);
  process.exit(1);
}
const srcDir = path.join(config.dataDir, hash);
const dir = path.join(srcDir, "playground");
await fs.mkdir(dir, { recursive: true });

const need = async <T>(name: string): Promise<T> => {
  const p = path.join(srcDir, name);
  if (!(await exists(p))) throw new Error(`missing ${name} in ${srcDir}; run the earlier stages first (npm run stage)`);
  const v = await readJson<any>(p);
  return (v && typeof v === "object" && "inputsKey" in v ? v.data : v) as T;
};
const ingest = await need<IngestArtifact>(ARTIFACTS.ingest);
const transcript = await need<Transcript>(ARTIFACTS.transcript);
const signals = await need<Signals>(ARTIFACTS.signals);

// These artifacts are read as-is, so a transcript left over from an older transcriber would be used
// silently and every result below would describe dialogue the pipeline no longer sees.
if (!transcript.providers?.scribe) {
  throw new Error(
    `${ARTIFACTS.transcript} in ${srcDir} was not produced by Scribe (providers: ${JSON.stringify(transcript.providers)}).\n` +
      `  Rebuild it first: npm run stage -w server -- transcribe ${hash.slice(0, 8)}\n` +
      `  (free when the raw responses are already cached under transcribe/scribe-*)`,
  );
}

// The episode summary is itself cached (keyed on the transcript + model, like every other artifact),
// so a real pipeline run on this video has probably already paid for it. Reuse that copy the first
// time this video is played with here, instead of paying for it again; runStory still recomputes it
// on its own if the transcript or model has since changed, or leaves an existing playground copy alone.
const playgroundProgramme = path.join(dir, ARTIFACTS.programme);
if (!(await exists(playgroundProgramme)) && (await exists(path.join(srcDir, ARTIFACTS.programme)))) {
  await fs.copyFile(path.join(srcDir, ARTIFACTS.programme), playgroundProgramme);
}

if (!flags.includes("--cached")) await fs.rm(path.join(dir, ARTIFACTS.placement), { force: true });

const catalogue = await openCatalogue();
const ctx = makeContext({ jobId: hash.slice(0, 8), dir, videoPath: (await findSourceVideo(srcDir))!, catalogue });
console.log(`video ${hash.slice(0, 8)} · ${ingest.meta.durationSec.toFixed(0)}s · ${transcript.segments.length} lines · model ${config.openrouter.reasonModel}\n`);

const t0 = Date.now();
const { breaks, slots } = await runPlacement(ctx, ingest, transcript, signals);

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const name = (id: string) => catalogue.brands.find((b) => b.id === id)?.name ?? id;
for (const s of slots) {
  console.log(`chunk ${s.slot} · ${mmss(s.window[0])}–${mmss(s.window[1])} · ${s.currentLines} lines`);
  if (s.error) console.log(`  ✗ ${s.error}`);
  if (s.answer && !s.answer.placement) console.log(`  model placed nothing: ${s.answer.why_not_others}`);
  for (const o of s.options) {
    const at = o.cutTime !== undefined ? ` cut ${o.cutTime.toFixed(1)}s (${o.basis})` : "";
    console.log(`  ${o.outcome === "accepted" ? "✓" : "✗"} line ${o.lineId} ${name(o.brandId)} fit ${o.fit}${at}\n      ${o.reason}`);
    for (const p of o.problems) console.log(`      - ${p}`);
  }
}
console.log(`\n${breaks.length} ads: ${breaks.map((b) => `${mmss(b.timeSec)} ${name(b.brandId)}`).join(", ") || "none"}`);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s · full prompts and answers: ${path.join(dir, "placement-llm.jsonl")}`);
