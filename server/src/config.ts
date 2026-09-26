// The single source of tunable settings: env, model slugs, pacing, thresholds.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { PacingConfig, ScoreWeights, Thresholds } from "shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

const resolveFromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));

export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** Base URL baked into VMAP AdTagURIs and VAST MediaFiles. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  dataDir: resolveFromRoot(process.env.DATA_DIR ?? "data"),
  cataloguePath: resolveFromRoot(process.env.CATALOGUE_PATH ?? "catalogue/brands.json"),
  maxUploadBytes: 4 * 1024 ** 3,

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: "https://openrouter.ai/api/v1",
    /** "llm": audio-capable chat model with structured output (default; far better Bengali).
     *  "whisper": /audio/transcriptions endpoint, kept as a fallback. */
    transcribeProvider: (process.env.TRANSCRIBE_PROVIDER ?? "llm") as "llm" | "whisper",
    transcribeModel: process.env.MODEL_TRANSCRIBE ?? "google/gemini-3.8-flash",
    whisperModel: process.env.MODEL_WHISPER ?? "openai/whisper-1",
    reasonModel: process.env.MODEL_REASON ?? "openai/gpt-5.6-luna",
    requestTimeoutMs: 90_000,
    concurrency: 4,
    retries: 1,
  },

  /** Language of the content; used to prefer matching ad creatives. Not sent to Whisper:
   *  OpenAI's whisper-1 rejects `language=bn` (400), and auto-detect returns Bengali. */
  contentLanguage: "bn",

  transcription: {
    /** Words separated by at least this pause start a new utterance segment. */
    utterancePauseSec: 0.5,
    /** Utterances are split once they reach this length. */
    maxUtteranceSec: 15,
  },

  audio: {
    sampleRate: 16_000,
    bitrate: "32k",
    /** 2 min keeps LLM transcription timestamps tight and every call well inside timeouts. */
    chunkSec: 120,
  },

  signals: {
    silenceNoiseDb: -35,
    silenceMinSec: 0.3,
    sceneThreshold: 0.3,
    sceneScaleWidth: 320,
  },

  scenes: {
    windowSec: 360,
    overlapSec: 60,
  },

  pacing: {
    maxBreaksPerHour: 4,
    minGapSec: 480,
    maxAdLoadPct: 0.15,
    noBreakFirstSec: 180,
    noBreakLastSec: 120,
    minSilenceMs: 700,
  } satisfies PacingConfig,

  thresholds: {
    sceneMinConfidence: 0.6,
    negativeTagMinConfidence: 0.3,
    cutPaddingMs: 150,
    /** Every cut must sit inside a measured ffmpeg silence window. Transcript timing alone is
     *  never trusted to prove nobody is speaking (LLM/Whisper timestamps drift, speech gets missed). */
    requireSilenceConfirmation: true,
    /** LLM transcript timestamps drift by a few seconds, so look this far either side of the
     *  estimated scene change for the real pause. The cut still has to be in measured silence. */
    boundarySearchSec: 3,
    minGapWithoutSilenceMs: 2000,
    chunkSeamGuardMs: 1000,
    hallucinationSilenceOverlap: 0.6,
    hallucinationNoSpeechProbAlone: 0.9,
    hallucinationNoSpeechProb: 0.6,
    hallucinationAvgLogprob: -1.0,
    hallucinationCompressionRatio: 2.4,
  } satisfies Thresholds,

  scoring: {
    where: { gap: 0.3, shotCut: 0.2, closure: 0.3, calm: 0.2 },
    gapSaturationSec: 3,
    combined: { where: 0.6, brandFit: 0.4 },
  } satisfies ScoreWeights,
};

export type AppConfig = typeof config;
