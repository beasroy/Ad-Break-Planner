import { z } from "zod";
import type { Scene } from "shared";

export const PROGRAMME_PROMPT_VERSION = 1;

export const programmeSystemPrompt = [
  "You read the scene-by-scene summary of one Bengali TV episode and describe the programme as a whole.",
  "summary: one English sentence on what the programme is about.",
  "genre: a few words (e.g. 'food travel show', 'family drama', 'crime thriller').",
  "recurring_contexts: up to 8 short phrases for activities, settings or objects that recur across many scenes (e.g. 'cooking', 'eating', 'travel', 'phone calls').",
].join("\n");

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const programmeUserPrompt = (scenes: Scene[]) =>
  scenes.map((s) => `[${mmss(s.start)}] ${s.activity} — ${s.summary}`).join("\n");

export const programmeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "genre", "recurring_contexts"],
  properties: {
    summary: { type: "string" },
    genre: { type: "string" },
    recurring_contexts: { type: "array", items: { type: "string" } },
  },
};

export const ProgrammeResponse = z.object({
  summary: z.string(),
  genre: z.string(),
  recurring_contexts: z.array(z.string()),
});
