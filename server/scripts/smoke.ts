// Smoke test: one real Scribe call and one Luna structured-output call (with an image),
// logging raw response shapes so we know what fields actually come back.
// Usage: npm run smoke -w server -- [path/to/video-or-audio]  (defaults to the first placeholder creative)
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config";
import { openCatalogue } from "../src/catalogue/store";
import { run } from "../src/lib/ffmpeg";
import { transcribeScribe } from "../src/lib/scribe";
import { chatJson } from "../src/lib/openrouter";

const scratch = path.join(config.dataDir, "_smoke");
await fs.mkdir(scratch, { recursive: true });
const catalogue = await openCatalogue();
const input = process.argv[2] ?? catalogue.brands[0].creatives[0].file;

// 1. Scribe: 60s of mono 16k mp3.
const audio = path.join(scratch, "sample.mp3");
await run("ffmpeg", ["-y", "-v", "error", "-i", input, "-t", "60", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
const sc = await transcribeScribe(audio);
const words = sc.words ?? [];
console.log("=== Scribe top-level keys:", Object.keys(sc));
console.log("=== Scribe word count:", words.length, "fields:", words[0] ? Object.keys(words[0]) : "n/a");
console.log("=== Scribe language:", sc.language_code, "audioSec:", sc.audio_duration_secs);
for (const w of words.filter((x) => x.type === "audio_event").slice(0, 5)) console.log(`  event ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`);
for (const w of words.filter((x) => (x.type ?? "word") === "word").slice(0, 8)) console.log(`  word  ${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text}`);
await fs.writeFile(path.join(scratch, "scribe-raw.json"), JSON.stringify(sc, null, 2));

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
