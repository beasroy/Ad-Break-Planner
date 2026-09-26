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
  /** Seconds either side of the estimated scene change to search for measured silence. */
  boundarySearchSec: number;
  /** Allow cuts where BOTH transcribers hear no speech (e.g. music-only transitions), when no
   *  measured silence is available. */
  allowSpeechFreeCuts: boolean;
  /** Minimum speech-free length (after padding) for such a cut. */
  minSpeechFreeSec: number;
  /** Re-transcribe each candidate's cut window on its own and keep the cut away from any word heard. */
  recheckCuts: boolean;
  /** Distance the cut must keep from any word the re-listen hears. */
  recheckPadSec: number;
  /** Ask an audio LLM "is anyone speaking within 1s of the cut?" for every brand-matched cut. */
  listenCheckCuts: boolean;
  /** When true, a cut is only allowed inside a measured silence window (or a speech-free gap, see above). */
  requireSilenceConfirmation: boolean;
  /** Only when requireSilenceConfirmation is false: unconfirmed gaps need at least this length. */
  minGapWithoutSilenceMs: number;
  /** Gaps touching a transcription chunk seam (± this) need silence confirmation. */
  chunkSeamGuardMs: number;
  /** Fraction of a segment inside silence windows above which it is treated as hallucinated. */
  hallucinationSilenceOverlap: number;
  /** Brands the ranker scores below this fit are not placed. */
  minBrandFit: number;
  /** Negative contexts listed by more than this share of brands block every brand. */
  consensusNegativeShare: number;
}

export interface ScoreWeights {
  where: { gap: number; shotCut: number; closure: number; calm: number };
  /** Gap sub-score multiplier for speech-free (music) cuts: real silence is preferred. */
  speechFreeGapFactor: number;
  /** Gap length (sec) at which the gap sub-score saturates to 1. */
  gapSaturationSec: number;
  combined: { where: number; brandFit: number };
}
