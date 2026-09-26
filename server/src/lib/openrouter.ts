import { config } from "../config";
import { recordModelCall } from "./callContext";
import { HttpError, createRateLimiter, withRetry } from "./retry";

const { openrouter: or } = config;
const acquire = createRateLimiter(or.rpmPerModel);

async function post(endpoint: string, body: BodyInit, headers: Record<string, string> = {}) {
  if (!or.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch(`${or.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${or.apiKey}`, ...headers },
    body,
    signal: AbortSignal.timeout(or.requestTimeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError("OpenRouter", res.status, text);
  return JSON.parse(text);
}

export type ChatContent =
  | string
  | (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
      | { type: "input_audio"; input_audio: { data: string; format: string } }
    )[];

/** Chat completion with JSON-schema structured output. Returns the parsed JSON object (unvalidated). */
export async function chatJson(opts: {
  label: string;
  system: string;
  user: ChatContent;
  schemaName: string;
  schema: object;
  /** Defaults to the reasoning model. */
  model?: string;
}): Promise<unknown> {
  const model = opts.model ?? or.reasonModel;
  return withRetry(
    opts.label,
    or.retries,
    async () => {
      await acquire(model);
      const started = new Date();
      let res: any;
      try {
        res = await post(
          "/chat/completions",
          JSON.stringify({
            model,
            messages: [
              { role: "system", content: opts.system },
              { role: "user", content: opts.user },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
            },
            usage: { include: true },
          }),
          { "Content-Type": "application/json" },
        );
      } catch (err) {
        recordModelCall({
          provider: "openrouter",
          model,
          label: opts.label,
          startedAt: started.toISOString(),
          latencyMs: Date.now() - started.getTime(),
          ok: false,
          httpStatus: err instanceof HttpError ? err.status : undefined,
          error: (err as Error).message,
        });
        throw err;
      }
      recordModelCall({
        provider: "openrouter",
        model,
        label: opts.label,
        startedAt: started.toISOString(),
        latencyMs: Date.now() - started.getTime(),
        ok: true,
        httpStatus: 200,
        inputTokens: res?.usage?.prompt_tokens,
        outputTokens: res?.usage?.completion_tokens,
        costUsd: typeof res?.usage?.cost === "number" ? res.usage.cost : undefined,
      });
      const content = res?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error(`${opts.label}: no message content in response`);
      return JSON.parse(content);
    },
    or.rateLimitRetries,
  );
}

/** One generated image (JPEG/PNG bytes) from a text prompt. */
export async function generateImage(opts: { label: string; prompt: string; model?: string }): Promise<{ bytes: Buffer; ext: string }> {
  const model = opts.model ?? or.imageModel;
  return withRetry(opts.label, or.retries, async () => {
    await acquire(model);
    const started = new Date();
    const log = (ok: boolean, extra: Record<string, unknown>) =>
      recordModelCall({
        provider: "openrouter",
        model,
        label: opts.label,
        startedAt: started.toISOString(),
        latencyMs: Date.now() - started.getTime(),
        ok,
        ...extra,
      });
    let res: any;
    try {
      res = await post(
        "/chat/completions",
        JSON.stringify({ model, modalities: ["image", "text"], messages: [{ role: "user", content: opts.prompt }], usage: { include: true } }),
        { "Content-Type": "application/json" },
      );
    } catch (err) {
      log(false, { httpStatus: err instanceof HttpError ? err.status : undefined, error: (err as Error).message });
      throw err;
    }
    log(true, { httpStatus: 200, outputTokens: res?.usage?.completion_tokens, costUsd: res?.usage?.cost });
    const url: string | undefined = res?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    const m = url?.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) throw new Error(`${opts.label}: no image in response`);
    return { bytes: Buffer.from(m[2], "base64"), ext: m[1] === "jpeg" ? "jpg" : m[1] };
  });
}
