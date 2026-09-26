// Smoke test: one real Deepgram call and one Luna structured-output call (with an image),
// logging raw response shapes so we know what fields actually come back.
// Usage: npm run smoke -w server -- [path/to/video-or-audio]  (defaults to the first placeholder creative)
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config";
import { loadCatalogue } from "../src/catalogue/loader";
import { run } from "../src/lib/ffmpeg";
import { transcribeDeepgram } from "../src/lib/deepgram";
import { chatJson } from "../src/lib/openrouter";

const scratch = path.join(config.dataDir, "_smoke");
await fs.mkdir(scratch, { recursive: true });
const catalogue = await loadCatalogue(config.cataloguePath);
const input = process.argv[2] ?? catalogue.brands[0].creatives[0].file;

// 1. Deepgram: 60s of mono 16k mp3.
const audio = path.join(scratch, "sample.mp3");
await run("ffmpeg", ["-y", "-v", "error", "-i", input, "-t", "60", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
const dg = await transcribeDeepgram(audio);
const utts = dg.results?.utterances ?? [];
console.log("=== Deepgram results keys:", Object.keys(dg.results ?? {}));
console.log("=== Deepgram utterance count:", utts.length, "fields:", utts[0] ? Object.keys(utts[0]) : "n/a");
for (const u of utts.slice(0, 5)) console.log(`  ${u.start.toFixed(2)}-${u.end.toFixed(2)} c${u.confidence.toFixed(2)} ${u.transcript}`);
await fs.writeFile(path.join(scratch, "deepgram-raw.json"), JSON.stringify(dg, null, 2));

// 2. Luna: structured output + one image.
const frame = path.join(scratch, "frame.jpg");
await run("ffmpeg", ["-y", "-v", "error", "-ss", "2", "-i", input, "-frames:v", "1", "-vf", "scale=320:-1", frame]);
const b64 = (await fs.readFile(frame)).toString("base64");
const luna = await chatJson({
  label: "smoke-luna",
  system: "You describe video frames. Reply only with the requested JSON.",
  user: [
    { type: "text", text: "Describe this frame and pick which contexts apply." },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
  ],
  schemaName: "smoke",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["description", "contexts"],
    properties: {
      description: { type: "string" },
      contexts: { type: "array", items: { type: "string", enum: catalogue.negativeVocab } },
    },
  },
});
console.log("=== Luna structured output:", JSON.stringify(luna, null, 2));
