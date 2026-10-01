// The single source of tunable settings: env, model slugs, pacing, thresholds.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { PacingConfig, ScoreWeights, Thresholds } from "shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

const resolveFromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));

/**
 * The server's public address, used in every ad, VAST and VMAP link. A value without a scheme
 * ("my-app.up.railway.app") would be read by browsers as a relative path and break every ad, so
 * https:// is added (http:// for localhost); trailing slashes are dropped.
 */
export function normaliseBaseUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(v)) return v;
  return `${/^(localhost|127\.|0\.0\.0\.0)/.test(v) ? "http" : "https"}://${v}`;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** Base URL baked into VMAP AdTagURIs and VAST MediaFiles. */
  publicBaseUrl: normaliseBaseUrl(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT ?? 4000}`),
  dataDir: resolveFromRoot(process.env.DATA_DIR ?? "data"),
  cataloguePath: resolveFromRoot(process.env.CATALOGUE_PATH ?? "catalogue/brands.json"),
  maxUploadBytes: 4 * 1024 ** 3,
  /** SQLite file: jobs, attempts, stage status, audit trail, model calls. Lives next to the artifacts. */
  dbPath: resolveFromRoot(process.env.DB_PATH ?? path.join(process.env.DATA_DIR ?? "data", "app.db")),

  /** Durable job queue (rows in the jobs table, claimed by a worker loop). */
  queue: {
    /** Pipelines running at once. One keeps every model under its rate limit. */
    concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 1),
    pollMs: 1000,
    /** Automatic attempts per run (first try + retries). A manual retry or re-upload grants a fresh budget. */
    maxAttempts: 3,
    /** Retry delay: base × 4^(n−1), capped (30s, 2m, 8m, ...). Cached stages make a retry resume where it failed. */
    backoffBaseSec: 30,
    backoffMaxSec: 600,
    /** A running job writes a heartbeat; one silent for staleAfterSec belongs to a dead process and is recovered. */
    heartbeatSec: 10,
    staleAfterSec: 60,
    /** An attempt running longer than this is failed at the next stage boundary. */
    attemptTimeoutSec: 60 * 60,
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: "https://openrouter.ai/api/v1",
    /** Audio-capable LLM used by the listen gate to re-check a cut when the VAD is unsure. */
    listenModel: process.env.MODEL_LISTEN ?? "google/gemini-3.8-flash",
    reasonModel: process.env.MODEL_REASON ?? "openai/gpt-5.6-luna",
    requestTimeoutMs: 90_000,
    concurrency: 4,
    retries: 1,
    /** Stay under OpenRouter's per-model rate limit (new accounts: 20 requests/min per model). */
    rpmPerModel: 18,
    /** Extra retries, with backoff, for 429 rate-limit responses only. */
    rateLimitRetries: 4,
  },

  /** The only transcriber: audio-aligned word timestamps, Bengali text, and audio-event tags. */
  scribe: {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    baseUrl: "https://api.elevenlabs.io/v1",
    model: process.env.SCRIBE_MODEL ?? "scribe_v2",
    language: "ben",
    diarize: true,
    /** Pause (sec) that splits one run of words into separate utterances. */
    uttSplitSec: 0.5,
    /** Scribe word timing is tight (median 0.22s, p99 1.2s), but a rare span runs to tens of
     *  seconds; capping bounds that without truncating real words. */
    maxWordSec: 2.0,
    /** Audio events ([music], [crying], [screaming]) carry no words but are not silence, so they
     *  count as speech walls: no cut may land inside one. */
    audioEventsAreSpeech: true,
    /** Billed per hour of audio; Scribe returns no price, so cost is derived from this. */
    usdPerHour: Number(process.env.SCRIBE_USD_PER_HOUR ?? 0.22),
    requestTimeoutMs: 180_000,
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

  /** How ad breaks are placed. */
  placement: {
    /** "llm": one LLM call per ad slot reads the transcript (with measured silences and shot cuts) and picks
     *  the line and brand; code still enforces the safety rules. "rules": the older scene → candidate →
     *  rank → select pipeline. */
    mode: (process.env.PLACEMENT_MODE === "rules" ? "rules" : "llm") as "llm" | "rules",
    /** Seconds of dialogue shown before and after each slot, as context. */
    contextSec: 90,
    /** No ad in the last this-many seconds of the episode (llm mode). */
    noAdLastSec: 90,
    /** Subtracted from a schedule candidate's score for every earlier use of the same brand in the
     *  episode (llm mode): a tie-break against repeats, not a ban — see placement.ts's maxBrandRepeats
     *  for the hard cap. With a small catalogue, some repetition across an episode is unavoidable. */
    brandRepeatPenalty: 0.15,
    /** Minimum fit to place an ad in llm mode (the rules mode uses thresholds.minBrandFit, 0.3): a
     *  strict quality gate — an option scoring below this is never shown, whatever else is going on. */
    minBrandFit: 0.7,
    /** Measured silences shorter than this are not shown to the model. */
    showSilenceMinSec: 0.5,
  },

  /** Final "is anyone speaking at the cut?" gate for brand-matched cuts. */
  listen: {
    /** Seconds either side of the cut that must be free of speech. */
    windowSec: 1,
    /** Silero VAD (local, free) decides the clear cases. At or above this = speech: reject, no LLM call. */
    vadSpeechMin: 0.9,
    /** Below this, and no Deepgram word in the window = quiet: accept, no LLM call. */
    vadQuietMax: 0.1,
    /** In between, the audio LLM is asked this many times; any "speech" (with words) or failed call = no ad.
     *  The LLM is only a tie-breaker: on quiet audio it invents plausible dialogue, so it never decides clear cases. */
    llmVotes: 2,
    vadModelPath: resolveFromRoot("server/models/silero_vad.onnx"),
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
    listenCheckCuts: process.env.LISTEN_CHECK_CUTS !== "false",
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
