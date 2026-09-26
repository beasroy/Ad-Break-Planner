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
    /** Fallback transcriber (per chunk, when Deepgram fails): audio-capable LLM with structured output.
     *  Good Bengali text, but timestamps can drift by seconds. */
    transcribeModel: process.env.MODEL_TRANSCRIBE ?? "google/gemini-3.8-flash",
    reasonModel: process.env.MODEL_REASON ?? "openai/gpt-5.6-luna",
    requestTimeoutMs: 90_000,
    concurrency: 4,
    retries: 1,
    /** Stay under OpenRouter's per-model rate limit (new accounts: 20 requests/min per model). */
    rpmPerModel: 18,
    /** Extra retries, with backoff, for 429 rate-limit responses only. */
    rateLimitRetries: 4,
  },

  /** Primary transcriber: audio-aligned word/utterance timestamps. nova-3 is the only Deepgram model with Bengali. */
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY ?? "",
    baseUrl: "https://api.deepgram.com/v1",
    model: process.env.DEEPGRAM_MODEL ?? "nova-3",
    language: "bn",
    /** Pause (sec) that splits utterances. */
    uttSplitSec: 0.5,
    /** Deepgram stretches a word's end across a following pause (seen up to 20s). Speech walls use
     *  each word capped to this length from its start; real Bengali words are well under 1s. */
    maxWordSec: 1.0,
    requestTimeoutMs: 60_000,
    retries: 1,
  },

  /** Language of the content; used to prefer matching ad creatives. */
  contentLanguage: "bn",

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
     *  never trusted to prove nobody is speaking (LLM timestamps drift; any transcriber can miss speech). */
    requireSilenceConfirmation: true,
    /** Second way to prove nobody is speaking: Deepgram (audio-aligned words) AND Gemini both hear
     *  no speech for this long. Unlocks music-only transitions, where TV normally cuts to ads. */
    allowSpeechFreeCuts: true,
    minSpeechFreeSec: 1.5,
    /** Independent re-listen: Deepgram on a short clip of just the cut window. The full-chunk
     *  pass can miss words the isolated clip reveals; disagreement = move the cut or drop it. */
    recheckCuts: true,
    recheckPadSec: 0.5,
    /** Final gate: an audio LLM listens to 6s around each brand-matched cut and is asked directly
     *  whether anyone speaks within 1s of it. Caught shouted dialogue both transcribers missed. */
    listenCheckCuts: true,
    /** LLM transcript timestamps drift by a few seconds, so look this far either side of the
     *  estimated scene change for the real pause. The cut still has to be in measured silence. */
    boundarySearchSec: 3,
    minGapWithoutSilenceMs: 2000,
    chunkSeamGuardMs: 1000,
    hallucinationSilenceOverlap: 0.6,
    /** Ranker fit below this = the brand is unrelated to the scene = don't place it. */
    minBrandFit: 0.3,
    /** A negative context listed by more than this share of catalogue brands blocks every brand
     *  (computed from the catalogue at runtime, so it adapts when brands are added). */
    consensusNegativeShare: 0.5,
  } satisfies Thresholds,

  scoring: {
    where: { gap: 0.3, shotCut: 0.2, closure: 0.3, calm: 0.2 },
    speechFreeGapFactor: 0.7,
    gapSaturationSec: 3,
    combined: { where: 0.6, brandFit: 0.4 },
  } satisfies ScoreWeights,
};

export type AppConfig = typeof config;
