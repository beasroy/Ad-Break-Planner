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
    transcribeModel: process.env.MODEL_TRANSCRIBE ?? "openai/whisper-1",
    reasonModel: process.env.MODEL_REASON ?? "openai/gpt-5.6-luna",
    transcribeLanguage: "bn",
    requestTimeoutMs: 90_000,
    concurrency: 4,
    retries: 1,
  },

  audio: {
    sampleRate: 16_000,
    bitrate: "32k",
    chunkSec: 300,
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
    minGapWithoutSilenceMs: 2000,
    chunkSeamGuardMs: 1000,
    hallucinationSilenceOverlap: 0.6,
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
