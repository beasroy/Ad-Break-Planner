import { z } from "zod";

export const TRANSCRIBE_PROMPT_VERSION = 1;

export const transcribeSystemPrompt = "You are a precise speech transcriber for Bengali TV dramas.";

export const transcribeUserText = [
  "Transcribe every spoken line in this audio verbatim in Bengali script.",
  "One utterance per spoken sentence or short phrase, with start and end time in seconds from the start of this clip.",
  "Keep utterances in time order. Do not transcribe music, songs without words, or background sounds. Do not translate.",
  "If nobody speaks, return an empty list.",
].join(" ");

export const transcribeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["utterances"],
  properties: {
    utterances: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "text"],
        properties: { start: { type: "number" }, end: { type: "number" }, text: { type: "string" } },
      },
    },
  },
};

export const TranscribeResponse = z.object({
  utterances: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});
