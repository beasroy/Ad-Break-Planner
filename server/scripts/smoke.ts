// Phase 0 smoke test: one real Whisper call and one Luna structured-output call
// (with an image), logging raw responses so we know what fields actually come back.
// Usage: npm run smoke -w server -- [path/to/video-or-audio]  (defaults to the first placeholder creative)
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config";
import { loadCatalogue } from "../src/catalogue/loader";
import { run } from "../src/lib/ffmpeg";
import { chatJson, transcribeWhisper as transcribe } from "../src/lib/openrouter";

const scratch = path.join(config.dataDir, "_smoke");
await fs.mkdir(scratch, { recursive: true });
const catalogue = await loadCatalogue(config.cataloguePath);
const input = process.argv[2] ?? catalogue.brands[0].creatives[0].file;

// 1. Whisper: 60s of mono 16k mp3.
const audio = path.join(scratch, "sample.mp3");
await run("ffmpeg", ["-y", "-i", input, "-t", "60", "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", audio]);
const whisper = await transcribe(audio);
console.log("=== Whisper top-level keys:", Object.keys(whisper));
console.log("=== Whisper segment count:", whisper.segments?.length ?? "NO SEGMENTS");
console.log("=== Whisper segment fields:", whisper.segments?.[0] ? Object.keys(whisper.segments[0]) : "n/a");
console.log("=== Whisper segments (start, end, no_speech_prob, avg_logprob):", whisper.segments?.map((s: any) => [s.start, s.end, s.no_speech_prob, s.avg_logprob]));
console.log("=== Whisper word count:", whisper.words?.length ?? "NO WORDS", "fields:", whisper.words?.[0] ? Object.keys(whisper.words[0]) : "n/a");
console.log("=== Whisper first 5 words:", JSON.stringify(whisper.words?.slice(0, 5)));
await fs.writeFile(path.join(scratch, "whisper-raw.json"), JSON.stringify(whisper, null, 2));

// 2. Luna: structured output + one image.
const frame = path.join(scratch, "frame.jpg");
await run("ffmpeg", ["-y", "-ss", "2", "-i", input, "-frames:v", "1", "-vf", "scale=320:-1", frame]);
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
