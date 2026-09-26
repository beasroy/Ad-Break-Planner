import { describe, expect, it } from "vitest";
import { buildTranscript, chunkUtterances } from "../src/stages/transcribe";
import { config } from "../src/config";

const opts = config.transcription;
const chunk = { index: 1, file: "c.mp3", offsetSec: 300, durationSec: 300 };

// Shape taken from the real smoke-test response (Bengali, whisper-1 via OpenRouter).
const raw = {
  segments: [
    { start: 8.84, end: 29.7, text: "a b c d", no_speech_prob: 0.6, avg_logprob: -0.31, compression_ratio: 1.2 },
    { start: 59.68, end: 59.96, text: "zz", no_speech_prob: 0.93, avg_logprob: -0.07, compression_ratio: 1 },
  ],
  words: [
    { word: "a", start: 8.84, end: 9.4 },
    { word: "b", start: 9.4, end: 9.8 },
    { word: "c", start: 12.0, end: 12.4 },
    { word: "d", start: 12.4, end: 12.4 },
    { word: "zz", start: 59.7, end: 59.9 },
  ],
};

describe("chunkUtterances", () => {
  it("splits words into utterances at pauses and shifts to absolute time", () => {
    const u = chunkUtterances(raw, chunk, opts);
    expect(u.map((x) => [x.start, x.text])).toEqual([
      [308.84, "a b"],
      [312.0, "c d"],
      [359.7, "zz"],
    ]);
    expect(u[1].end).toBeGreaterThan(u[1].start); // zero-length last word still yields a positive span
    expect(u[0].noSpeechProb).toBe(0.6);
  });

  it("accepts LLM utterances: shifts, clamps to the chunk and drops malformed ones", () => {
    const u = chunkUtterances(
      {
        utterances: [
          { start: 2, end: 3.9, text: "তুমি কি সবাইরে এখানে নিয়ে আসো?" },
          { start: 5, end: 4, text: "backwards" },
          { start: 6, end: 7, text: "  " },
          { start: 298, end: 305, text: "runs past chunk end" },
        ],
      },
      chunk,
      opts,
    );
    expect(u.map((x) => [x.start, x.end])).toEqual([
      [302, 303.9],
      [598, 600],
    ]);
  });

  it("falls back to Whisper segments when no words are returned", () => {
    const u = chunkUtterances({ segments: raw.segments }, chunk, opts);
    expect(u).toHaveLength(2);
    expect(u[0].start).toBeCloseTo(308.84);
  });
});

describe("buildTranscript", () => {
  it("never drops LLM text for silence overlap (its timestamps are approximate)", () => {
    const llm = { utterances: [{ start: 12, end: 13, text: "real line with drifted timing" }] };
    const t = buildTranscript([{ chunkIndex: 1, raw: llm }], [chunk], [{ start: 300, end: 320 }], config.thresholds, opts);
    expect(t.segments[0].dropped).toBeUndefined();
  });

  it("flags hallucinations but keeps them as segments", () => {
    const t = buildTranscript([{ chunkIndex: 1, raw }], [chunk], [{ start: 312, end: 313 }], config.thresholds, opts);
    const byText = Object.fromEntries(t.segments.map((s) => [s.text, s]));
    expect(byText["a b"].dropped).toBeUndefined();
    expect(byText["c d"].dropped?.reason).toMatch(/silence/);
    expect(byText["zz"].dropped?.reason).toMatch(/no_speech_prob/);
    expect(t.segments.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(t.rawFieldsSeen).toContain("words.word");
  });
});
