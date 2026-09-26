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
  noSpeechProb?: number;
  avgLogprob?: number;
  compressionRatio?: number;
  /** Set when the hallucination filter removed it from the transcript. Still counts as occupied time for cuts. */
  dropped?: { reason: string };
}

export interface Transcript {
  segments: Segment[];
  /** Absolute times (sec) where one chunk ends and the next begins. */
  chunkSeams: number[];
  /** Per-segment field names Whisper actually returned (logged for the hallucination filter). */
  rawFieldsSeen: string[];
}

export interface Interval {
  start: number;
  end: number;
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

export interface DebugReport {
  jobId: string;
  fileHash: string;
  meta: VideoMeta;
  config: unknown;
  transcriptStats: { segments: number; dropped: number; rawFieldsSeen: string[] };
  scenes: Scene[];
  candidates: (Candidate | MatchedCandidate)[];
  selection: SelectionLog[];
  breaks: Break[];
}
