// Run only the LLM placement stage against a video's cached upstream artifacts (ingest, transcript,
// signals), so a prompt or logic change can be tried without the full pipeline.
// Only the LLM calls cost money (one per chunk, plus one episode summary, cached in playground/).
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
