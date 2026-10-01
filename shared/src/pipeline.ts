import type { CallKindUsage, StageUsage } from "./job";

export interface VideoMeta {
  durationSec: number;
  startTimeSec: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec?: string;
}

export interface AudioChunk {
  index: number;
  file: string;
  offsetSec: number;
  durationSec: number;
}

export interface IngestArtifact {
  meta: VideoMeta;
  fullAudio: string;
  chunks: AudioChunk[];
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  chunkIndex: number;
  /** Which transcriber produced it. */
  source: "scribe";
  /** Transcriber confidence (Deepgram utterance confidence), when available. */
  confidence?: number;
  /** Set when the hallucination filter removed it from the transcript. Still counts as occupied time for cuts. */
  dropped?: { reason: string };
}

export interface Transcript {
  segments: Segment[];
  /** Absolute times (sec) where one chunk ends and the next begins. */
  chunkSeams: number[];
  /** Per-utterance field names the transcriber actually returned. */
  rawFieldsSeen: string[];
  /** Chunks each provider covered, e.g. { deepgram: 12, llm: 12 } when both succeeded everywhere. */
  providers: Record<string, number>;
  /** Audio-aligned speech intervals: every Scribe word (each capped), plus audio-event spans,
   *  which carry no words but are not silence either. Hard walls for cuts. */
  speech: Interval[];
  /** Time ranges the transcriber covered, i.e. where `speech` is complete. "Nobody is speaking"
   *  is only ever inferred inside these ranges. */
  speechCoverage: Interval[];
  /** Non-speech sound Scribe named ([music], [crying], [screaming]). Already folded into `speech`;
   *  kept separately because what the sound is matters for whether an ad belongs there. */
  audioEvents: AudioEvent[];
}

export interface Interval {
  start: number;
  end: number;
}

export interface AudioEvent extends Interval {
  /** Scribe's own label, e.g. "[বাদ্যসঙ্গীত]", "[screaming]". */
  text: string;
}

export interface Signals {
  silences: Interval[];
  shotCuts: number[];
}

export interface NegativeTag {
  context: string;
  confidence: number;
  source: "transcript" | "keyframe";
}

export interface Scene {
  id: number;
  /** Kept (non-dropped) transcript segment ids. */
  firstSegmentId: number;
  lastSegmentId: number;
  start: number;
  end: number;
  summary: string;
  activity: string;
  mood: string;
  /** 0–1: how resolved the scene feels at its end. */
  closure: number;
  /** 0–1: how much unresolved tension carries past its end. */
  tension: number;
  /** 0–1: classification confidence. Below threshold = unclassified. */
  confidence: number;
  negativeTags: NegativeTag[];
}

export interface WhereScore {
  gap: number;
  shotCut: number;
  closure: number;
  calm: number;
  total: number;
}

export interface BlockReason {
  context: string;
  /** "brand": on this brand's own list; "consensus": listed by most brands, so it blocks all. */
  rule: "brand" | "consensus";
  scene: "before" | "after";
  confidence: number;
  source: NegativeTag["source"];
}

export interface BrandDecision {
  brandId: string;
  eligible: boolean;
  blockedBy?: BlockReason[];
  /** Set when the whole candidate is unclassified. */
  unclassified?: boolean;
  fit?: number;
  reason?: string;
}

export type Rejection = { stage: "candidates" | "match" | "select"; reason: string };

export interface Candidate {
  id: string;
  sceneBeforeId: number;
  sceneAfterId: number;
  /** Speech-free interval between the two scenes' speech. */
  gap: Interval;
  /** Sub-interval where a cut is allowed (speech-free, padded, silence-confirmed when available). */
  safe?: Interval;
  cutTime?: number;
  snappedTo?: "shotCut" | "silenceMidpoint" | "gapMidpoint";
  /** Why the cut is safe: measured silence, or both transcribers hear no speech (e.g. music only). */
  cutBasis?: "silence" | "speechFree";
  /** Independent re-listen of just the cut window (Deepgram on a short clip). */
  recheck?: { heardWords: number; moved: boolean };
  /**
   * Final "is anyone speaking within ±1s of the cut?" gate. Silero VAD decides clear cases
   * (method "vad"); only when it is unsure is the audio LLM asked (method "llm").
   */
  listenCheck?: {
    speech: boolean;
    method: "vad" | "llm";
    vad: { max: number; frac: number };
    speechNear: boolean;
    answers?: { speechNearMark: boolean; heard: string; transcript: string }[];
    reason: string;
  };
  where?: WhereScore;
  rejected?: Rejection;
}

export interface MatchedCandidate extends Candidate {
  brands: BrandDecision[];
  /** Eligible brands sorted by fit desc. */
  ranked: { brandId: string; fit: number; reason: string }[];
}

export interface Break {
  candidateId: string;
  timeSec: number;
  brandId: string;
  creativeId: string;
  adDurationSec: number;
  whereScore: number;
  fit: number;
  combinedScore: number;
  reason: string;
}

export interface SelectionLog {
  candidateId: string;
  outcome: "selected" | "rejected";
  reason: string;
}

export interface ProgrammeContext {
  summary: string;
  genre: string;
  /** Activities/settings that recur across the programme. */
  recurringContexts: string[];
}

export interface DebugReport {
  /** LLM placement mode: a plain-language account of how the ads were placed, and the settings that were used. */
  mode?: "llm";
  explanation?: string[];
  settingsUsed?: Record<string, unknown>;
  jobId: string;
  programme?: ProgrammeContext;
  fileHash: string;
  meta: VideoMeta;
  config: unknown;
  transcriptStats: { segments: number; dropped: number; rawFieldsSeen: string[] };
  /** Rules mode only. */
  scenes?: Scene[];
  candidates?: (Candidate | MatchedCandidate)[];
  /** One entry per candidate (rules mode) or per chunk (LLM mode). */
  selection: SelectionLog[];
  breaks: Break[];
  /** LLM placement mode: every chunk, what the model was shown, what it answered, and what code accepted or rejected. */
  placement?: unknown;
  /** Every API call recorded for this video, across every attempt (including earlier failed retries —
   *  it's money already spent), and what it cost. Omitted for a CLI/script run that never opened the
   *  database (npm run stage, playground). */
  costSummary?: { totalUsd: number; totalCalls: number; totalErrors: number; byStage: StageUsage[]; byKind: CallKindUsage[] };
}
