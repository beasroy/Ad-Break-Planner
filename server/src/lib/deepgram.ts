// Deepgram pre-recorded transcription. Response shape verified with a live call:
// results.utterances[] = { start, end, confidence, channel, transcript, words[], id },
// words[] = { word, start, end, confidence, punctuated_word }. Times are audio-aligned.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { recordModelCall } from "./callContext";
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
    const started = new Date();
    const log = (ok: boolean, extra: { httpStatus?: number; error?: string; audioSec?: number }) =>
      recordModelCall({
        provider: "deepgram",
        model: dg.model,
        label: path.basename(filePath),
        startedAt: started.toISOString(),
        latencyMs: Date.now() - started.getTime(),
        ok,
        ...extra,
      });
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${dg.baseUrl}/listen?${params}`, {
        method: "POST",
        headers: { Authorization: `Token ${dg.apiKey}`, "Content-Type": "audio/mpeg" },
        body: bytes,
        signal: AbortSignal.timeout(dg.requestTimeoutMs),
      });
      text = await res.text();
    } catch (err) {
      log(false, { error: (err as Error).message });
      throw err;
    }
    if (!res.ok) {
      log(false, { httpStatus: res.status, error: text.slice(0, 500) });
      throw new HttpError("Deepgram", res.status, text);
    }
    const body = JSON.parse(text);
    // Deepgram bills by audio duration and does not return a price.
    log(true, { httpStatus: res.status, audioSec: body?.metadata?.duration });
    return body;
  });
}
