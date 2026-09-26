import { describe, expect, it } from "vitest";
import { buildTranscript, deepgramPieces, deepgramSpeech, llmPieces } from "../src/stages/transcribe";
import { config } from "../src/config";

const chunk = { index: 1, file: "c.mp3", offsetSec: 120, durationSec: 120 };

// Shape taken from a real Deepgram nova-3 response (Bengali).
const deepgram = {
  results: {
    utterances: [
      {
        start: 1.2,
        end: 3.28,
        confidence: 0.9,
        channel: 0,
        transcript: "তুমি কি সবাই এখানে নিয়ে আসো?",
        words: [
          { word: "তুমি", start: 1.2, end: 1.5 },
          { word: "আসো", start: 1.6, end: 3.28 }, // stretched across a pause
        ],
        id: "a",
      },
      { start: 16.52, end: 21.23, confidence: 0.9, channel: 0, transcript: "উনি এসেছেন?", words: [{ word: "উনি", start: 16.52, end: 16.9 }], id: "b" },
      { start: 118, end: 125, confidence: 0.8, channel: 0, transcript: "runs past chunk end", words: [], id: "c" },
      { start: 30, end: 31, confidence: 0.5, channel: 0, transcript: "   ", words: [], id: "d" },
    ],
  },
};

const MAX_WORD = config.deepgram.maxWordSec;

const llm = { utterances: [{ start: 2, end: 3.9, text: "তুমি কি সবাইরে এখানে নিয়ে আসো?" }, { start: 5, end: 4, text: "backwards" }] };

describe("provider pieces", () => {
  it("maps Deepgram utterances to the absolute timeline, audio-aligned, clamped, empty dropped", () => {
    const u = deepgramPieces(deepgram, chunk);
    expect(u.map((x) => [x.start, x.end])).toEqual([
      [121.2, 123.28],
      [136.52, 141.23],
      [238, 240],
    ]);
    expect(u.every((x) => x.source === "deepgram" && !x.approxTiming)).toBe(true);
    expect(u[0].confidence).toBe(0.9);
  });

  it("marks LLM utterances as approximate timing and drops malformed ones", () => {
    const u = llmPieces(llm, chunk);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ start: 122, end: 123.9, source: "llm", approxTiming: true });
  });
});

describe("deepgramSpeech", () => {
  it("uses word timings as walls, capping words Deepgram stretched across a pause", () => {
    expect(deepgramSpeech(deepgram, chunk, 1)).toEqual([
      { start: 121.2, end: 121.5 },
      { start: 121.6, end: 122.6 }, // 1.68s word capped to 1s
      { start: 136.52, end: 136.9 },
    ]);
  });
});

describe("buildTranscript (hybrid)", () => {
  it("uses LLM text for scenes and Deepgram timing for speech walls when both succeed", () => {
    const t = buildTranscript([{ chunkIndex: 1, deepgram, llm }], [chunk], [], config.thresholds, MAX_WORD);
    expect(t.segments.every((s) => s.source === "llm")).toBe(true);
    expect(t.speech).toEqual(deepgramSpeech(deepgram, chunk, MAX_WORD));
    expect(t.providers).toEqual({ deepgram: 1, llm: 1 });
  });

  it("falls back to Deepgram text when the LLM failed on a chunk", () => {
    const t = buildTranscript([{ chunkIndex: 1, deepgram }], [chunk], [], config.thresholds, MAX_WORD);
    expect(t.segments.map((s) => s.source)).toEqual(["deepgram", "deepgram", "deepgram"]);
    expect(t.speech).toHaveLength(3);
  });

  it("keeps LLM text but has no speech walls when Deepgram failed on a chunk", () => {
    const t = buildTranscript([{ chunkIndex: 1, llm }], [chunk], [], config.thresholds, MAX_WORD);
    expect(t.segments).toHaveLength(1);
    expect(t.speech).toEqual([]);
  });

  it("flags audio-aligned text in silence, never LLM text", () => {
    const silences = [{ start: 120, end: 124 }];
    const dgOnly = buildTranscript([{ chunkIndex: 1, deepgram }], [chunk], silences, config.thresholds, MAX_WORD);
    expect(dgOnly.segments[0].dropped?.reason).toMatch(/silence/);
    const hybrid = buildTranscript([{ chunkIndex: 1, deepgram, llm }], [chunk], silences, config.thresholds, MAX_WORD);
    expect(hybrid.segments[0].dropped).toBeUndefined();
  });
});
