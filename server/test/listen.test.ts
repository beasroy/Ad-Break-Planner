import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { vadAround, windowScore } from "../src/lib/vad";
import { answerHasSpeech, speechIntervalNear, llmVerdict, vadGate } from "../src/stages/match/listen";

const T = { windowSec: 1, vadSpeechMin: 0.9, vadQuietMax: 0.1 };
const quiet = { speech_near_mark: false, heard_at_mark: "music", transcript: "" };

describe("vadGate", () => {
  it("rejects on clear voice activity, whatever Deepgram says", () => {
    expect(vadGate({ max: 0.95, frac: 0.3 }, false, T)).toBe("speech");
  });
  it("accepts only when VAD is quiet AND no Deepgram word is near", () => {
    expect(vadGate({ max: 0.03, frac: 0 }, false, T)).toBe("quiet");
    expect(vadGate({ max: 0.03, frac: 0 }, true, T)).toBe("unsure");
  });
  it("sends the middle band to the LLM", () => {
    expect(vadGate({ max: 0.5, frac: 0.01 }, false, T)).toBe("unsure");
    expect(vadGate({ max: 0.1, frac: 0 }, false, T)).toBe("unsure");
  });
});

describe("answerHasSpeech", () => {
  it("needs both a speech verdict and words", () => {
    expect(answerHasSpeech({ speech_near_mark: true, heard_at_mark: "speech", transcript: "যাই" })).toBe(true);
    expect(answerHasSpeech({ speech_near_mark: false, heard_at_mark: "speech", transcript: "[0:03] আহ!" })).toBe(true);
    // Measured on a confirmed-quiet clip: "speech" three times, transcript empty every time.
    expect(answerHasSpeech({ speech_near_mark: true, heard_at_mark: "speech", transcript: "" })).toBe(false);
    expect(answerHasSpeech({ speech_near_mark: true, heard_at_mark: "speech", transcript: "[00:02 - 00:04]" })).toBe(false);
    expect(answerHasSpeech({ speech_near_mark: false, heard_at_mark: "music", transcript: "গান" })).toBe(false);
  });
});

describe("llmVerdict", () => {
  it("accepts only when every answer arrived and none heard speech", () => {
    expect(llmVerdict([quiet, quiet]).speech).toBe(false);
    expect(llmVerdict([quiet, { speech_near_mark: true, heard_at_mark: "speech", transcript: "চল" }]).speech).toBe(true);
    expect(llmVerdict([quiet, new Error("timeout")]).speech).toBe(true);
    expect(llmVerdict([]).speech).toBe(true);
  });
});

describe("speechIntervalNear", () => {
  it("finds a word overlapping ±1s of the cut", () => {
    expect(speechIntervalNear([{ start: 10.5, end: 10.9 }], 10, 1)).toBe(true);
    expect(speechIntervalNear([{ start: 8.2, end: 9.1 }], 10, 1)).toBe(true);
    expect(speechIntervalNear([{ start: 11.2, end: 11.5 }], 10, 1)).toBe(false);
  });
});

describe("windowScore", () => {
  it("scores only frames inside the window", () => {
    const p = [0.9, 0.9, 0.1, 0.2, 0.7, 0.9];
    // frames are 32 ms: window [0.064, 0.16) = frames 2..4
    expect(windowScore(p, 0.064, 0.16)).toEqual({ max: 0.7, frac: 1 / 3 });
  });
});

describe("Silero VAD (real model)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vad-test-"));
  const make = (name: string, src: string) => {
    const f = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-t", "8", "-ac", "1", "-ar", "16000", f]);
    return f;
  };

  it("hears no voice in silence or a pure tone", async () => {
    const silence = await vadAround(config.listen.vadModelPath, make("silence.wav", "anullsrc=r=16000:cl=mono"), 5, 1);
    const tone = await vadAround(config.listen.vadModelPath, make("tone.wav", "sine=frequency=440:sample_rate=16000"), 5, 1);
    expect(silence.max).toBeLessThan(0.1);
    expect(tone.max).toBeLessThan(0.1);
  });
});
