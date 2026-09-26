// Deepgram pre-recorded transcription. Response shape verified with a live call:
// results.utterances[] = { start, end, confidence, channel, transcript, words[], id },
// words[] = { word, start, end, confidence, punctuated_word }. Times are audio-aligned.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { HttpError, withRetry } from "./retry";

const { deepgram: dg } = config;

export async function transcribeDeepgram(filePath: string): Promise<any> {
  if (!dg.apiKey) throw new Error("DEEPGRAM_API_KEY is not set");
  const bytes = await fs.readFile(filePath);
  const params = new URLSearchParams({
    model: dg.model,
    language: dg.language,
    punctuate: "true",
    smart_format: "true",
    utterances: "true",
    utt_split: String(dg.uttSplitSec),
  });
  return withRetry(`deepgram ${path.basename(filePath)}`, dg.retries, async () => {
    const res = await fetch(`${dg.baseUrl}/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${dg.apiKey}`, "Content-Type": "audio/mpeg" },
      body: bytes,
      signal: AbortSignal.timeout(dg.requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError("Deepgram", res.status, text);
    return JSON.parse(text);
  });
}
