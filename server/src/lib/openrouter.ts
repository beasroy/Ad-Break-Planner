import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config";

const { openrouter: or } = config;

class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`OpenRouter HTTP ${status}: ${body.slice(0, 1000)}`);
  }
}

const isRetryable = (err: unknown) =>
  (err instanceof HttpError && (err.status >= 500 || err.status === 429)) ||
  (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= or.retries || !isRetryable(err)) throw err;
      console.warn(`[openrouter] ${label} failed (${(err as Error).message}); retrying`);
    }
  }
}

async function post(endpoint: string, body: BodyInit, headers: Record<string, string> = {}) {
  if (!or.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch(`${or.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${or.apiKey}`, ...headers },
    body,
    signal: AbortSignal.timeout(or.requestTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text);
}

/** Whisper transcription of one audio file. Returns the raw verbose_json response. */
export async function transcribe(filePath: string): Promise<any> {
  const bytes = await fs.readFile(filePath);
  return withRetry(`transcribe ${path.basename(filePath)}`, () => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(filePath));
    form.append("model", or.transcribeModel);
    form.append("language", or.transcribeLanguage);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("temperature", "0");
    return post("/audio/transcriptions", form);
  });
}

export type ChatContent =
  | string
  | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

/** Chat completion with JSON-schema structured output. Returns the parsed JSON object (unvalidated). */
export async function chatJson(opts: {
  label: string;
  system: string;
  user: ChatContent;
  schemaName: string;
  schema: object;
}): Promise<unknown> {
  return withRetry(opts.label, async () => {
    const res = await post(
      "/chat/completions",
      JSON.stringify({
        model: or.reasonModel,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
        },
      }),
      { "Content-Type": "application/json" },
    );
    const content = res?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`${opts.label}: no message content in response`);
    return JSON.parse(content);
  });
}
