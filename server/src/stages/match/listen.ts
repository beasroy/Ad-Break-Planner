// Pure decision rules for the final "is anyone speaking at the cut?" gate.
// VAD decides the clear cases; the audio LLM is only asked when VAD is unsure, because on quiet
// audio it invents plausible Bengali dialogue (measured: 6–7 of 9 calls on confirmed-quiet clips).
import type { Interval } from "shared";
import type { VadScore } from "../../lib/vad";

export interface ListenThresholds {
  windowSec: number;
  vadSpeechMin: number;
  vadQuietMax: number;
}

export interface LlmListenAnswer {
  speech_near_mark: boolean;
  heard_at_mark: string;
  transcript: string;
}

/** Pure: any Deepgram word inside ±windowSec of the cut. */
export const deepgramWordNear = (speech: Interval[], cut: number, windowSec: number) =>
  speech.some((w) => w.start < cut + windowSec && w.end > cut - windowSec);

/** Pure: "speech" / "quiet" when VAD (plus Deepgram) is clear, else "unsure" (ask the LLM). */
export function vadGate(vad: VadScore, deepgramNear: boolean, t: ListenThresholds): "speech" | "quiet" | "unsure" {
  if (vad.max >= t.vadSpeechMin) return "speech";
  if (vad.max < t.vadQuietMax && !deepgramNear) return "quiet";
  return "unsure";
}

/**
 * Pure: an LLM answer counts as speech only if it says so AND gives words it heard. A "speech"
 * flag with an empty transcript is the model contradicting itself, not evidence of speech.
 */
export const answerHasSpeech = (a: LlmListenAnswer) =>
  (a.speech_near_mark || a.heard_at_mark === "speech") && /\p{L}/u.test(a.transcript);

/** Pure: with VAD unsure, the cut is accepted only if every LLM answer arrived and none heard speech. */
export function llmVerdict(answers: (LlmListenAnswer | Error)[]): { speech: boolean; reason: string } {
  const failed = answers.filter((a): a is Error => a instanceof Error);
  if (failed.length || !answers.length) {
    return { speech: true, reason: `listening check failed, cannot confirm no speech (${failed[0]?.message.slice(0, 120) ?? "no answer"})` };
  }
  const heard = (answers as LlmListenAnswer[]).find(answerHasSpeech);
  return heard
    ? { speech: true, reason: `audio LLM heard speech at the cut (${heard.transcript.slice(0, 120)})` }
    : { speech: false, reason: `audio LLM heard no speech in ${answers.length}/${answers.length} checks` };
}
