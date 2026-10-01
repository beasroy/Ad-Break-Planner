// ElevenLabs Scribe transcription. Response shape verified against live calls:
// { language_code, language_probability, text, words[], transcription_id, audio_duration_secs },
// words[] = { text, start, end, type: "word" | "spacing" | "audio_event", speaker_id, logprob }.
// Times are audio-aligned. Scribe returns no utterances — transcribe.ts groups words into them.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { recordModelCall } from "./callContext";
import { HttpError, withRetry } from "./retry";

const { scribe: sc } = config;

export type ScribeWordType = "word" | "spacing" | "audio_event";

export interface ScribeWord {
  text: string;
  start: number;
  end: number;
  type?: ScribeWordType;
  speaker_id?: string;
}

export interface ScribeResponse {
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: ScribeWord[];
  transcription_id?: string;
  audio_duration_secs?: number;
}

export async function transcribeScribe(filePath: string): Promise<ScribeResponse> {
  if (!sc.apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const bytes = await fs.readFile(filePath);
  const name = path.basename(filePath);

  return withRetry(`scribe ${name}`, sc.retries, async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }), name);
    form.append("model_id", sc.model);
    if (sc.language) form.append("language_code", sc.language);
    // Word-level timing is what cuts are placed on; audio events mark music/laughter/crying,
    // which are speech walls too even though Scribe returns no words for them.
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "true");
    form.append("diarize", String(sc.diarize));

    const started = new Date();
    const log = (ok: boolean, extra: { httpStatus?: number; error?: string; audioSec?: number; costUsd?: number }) =>
      recordModelCall({
        provider: "elevenlabs",
        model: sc.model,
        label: name,
        startedAt: started.toISOString(),
        latencyMs: Date.now() - started.getTime(),
        ok,
        ...extra,
      });

    let res: Response;
    let text: string;
    try {
      res = await fetch(`${sc.baseUrl}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": sc.apiKey },
        body: form,
        signal: AbortSignal.timeout(sc.requestTimeoutMs),
      });
      text = await res.text();
    } catch (err) {
      log(false, { error: (err as Error).message });
      throw err;
    }
    if (!res.ok) {
      log(false, { httpStatus: res.status, error: text.slice(0, 500) });
      throw new HttpError("Scribe", res.status, text);
    }
    const body = JSON.parse(text) as ScribeResponse;
    // Scribe bills by audio duration and returns no price, so cost is derived from the rate.
    const audioSec = Number(body?.audio_duration_secs) || 0;
    log(true, { httpStatus: res.status, audioSec, costUsd: (audioSec / 3600) * sc.usdPerHour });
    return body;
  });
}
