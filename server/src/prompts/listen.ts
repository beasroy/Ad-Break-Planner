import { z } from "zod";

export const LISTEN_PROMPT_VERSION = 1;

/** Clip length and where the cut sits inside it. */
export const LISTEN_CLIP_SEC = 6;
export const LISTEN_CUT_AT_SEC = 3;

export const listenSystemPrompt = "You are a careful audio annotator for Bengali TV.";

export const listenUserText = [
  `This clip is ${LISTEN_CLIP_SEC} seconds long. Listen carefully to the window from ${LISTEN_CUT_AT_SEC - 1}.0s to ${LISTEN_CUT_AT_SEC + 1}.0s (centred on the ${LISTEN_CUT_AT_SEC}.0s mark).`,
  "Is any person speaking in that window (dialogue, even a single short word, 'hmm', or a shouted word)?",
  `What is mainly heard at the ${LISTEN_CUT_AT_SEC}.0s mark? Transcribe any speech in the whole clip with rough times.`,
].join(" ");

export const listenJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["speech_near_mark", "heard_at_mark", "transcript"],
  properties: {
    speech_near_mark: { type: "boolean" },
    heard_at_mark: { type: "string", enum: ["speech", "music", "singing", "silence", "ambient noise", "other"] },
    transcript: { type: "string" },
  },
};

export const ListenResponse = z.object({
  speech_near_mark: z.boolean(),
  heard_at_mark: z.string(),
  transcript: z.string(),
});
