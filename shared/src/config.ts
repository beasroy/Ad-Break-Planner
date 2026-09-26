export interface PacingConfig {
  maxBreaksPerHour: number;
  minGapSec: number;
  maxAdLoadPct: number;
  noBreakFirstSec: number;
  noBreakLastSec: number;
  minSilenceMs: number;
}

export interface Thresholds {
  /** Scene classification confidence below this = unclassified = no brand eligible. */
  sceneMinConfidence: number;
  /** A negative-context tag at or above this confidence blocks. */
  negativeTagMinConfidence: number;
  /** Cut point must be at least this far from any speech segment edge. */
  cutPaddingMs: number;
  /** Speech-free gaps with no confirming silence window need to be at least this long. */
  minGapWithoutSilenceMs: number;
  /** Gaps touching a transcription chunk seam (± this) need silence confirmation. */
  chunkSeamGuardMs: number;
  /** Fraction of a segment inside silence windows above which it is treated as hallucinated. */
  hallucinationSilenceOverlap: number;
  hallucinationNoSpeechProb: number;
  hallucinationAvgLogprob: number;
  hallucinationCompressionRatio: number;
}

export interface ScoreWeights {
  where: { gap: number; shotCut: number; closure: number; calm: number };
  /** Gap length (sec) at which the gap sub-score saturates to 1. */
  gapSaturationSec: number;
  combined: { where: number; brandFit: number };
}
