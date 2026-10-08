/** Gates code applies to the placement model's answers, and to the transcript it reads. */
export interface Thresholds {
  /** Cut point must be at least this far from any speech segment edge. */
  cutPaddingMs: number;
  /** Allow cuts where the transcriber hears no speech (e.g. music-only transitions), when no
   *  measured silence is available, and the minimum length (after padding) for such a cut. */
  minSpeechFreeSec: number;
  /** Ask "is anyone speaking within 1s of the cut?" (VAD, then an audio LLM when it is unsure)
   *  for every scheduled cut. */
  listenCheckCuts: boolean;
  /** Fraction of a segment inside silence windows above which it is treated as hallucinated. */
  hallucinationSilenceOverlap: number;
  /** Negative contexts listed by more than this share of brands block every brand. */
  consensusNegativeShare: number;
}

/** How a schedule candidate's score splits between the pause it sits in and the brand's fit. */
export interface ScheduleWeights {
  where: number;
  brandFit: number;
}
