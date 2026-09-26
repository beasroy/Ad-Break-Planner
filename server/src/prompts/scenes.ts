import { z } from "zod";
import type { Segment } from "shared";

export const SCENES_PROMPT_VERSION = 1;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${sec}`;
};

export function scenesSystemPrompt(negativeVocab: string[]): string {
  return [
    "You segment the transcript of a Bengali TV drama into scenes for ad-break planning.",
    "Each transcript line is: [segment_id] start–end text.",
    "",
    "A scene is a continuous stretch of story in one setting/time or one conversation. A new scene starts when the setting, time, or set of characters changes, or the conversation clearly ends and another begins.",
    "",
    "Rules:",
    "- Return scenes in order, contiguous, covering every segment id you were given exactly once.",
    "- Identify scenes ONLY by the segment ids shown. Never invent ids or timestamps.",
    "- summary: one English sentence. activity: the dominant on-screen activity in a few words (e.g. 'family eating dinner', 'phone call', 'hospital visit'). mood: one or two words.",
    "- closure (0–1): how resolved the scene feels at its END (1 = conversation/beat clearly finished).",
    "- tension (0–1): how much unresolved suspense or conflict is still running at its END (1 = cliffhanger, argument mid-flow).",
    "- confidence (0–1): how sure you are about this scene's summary and tags. Use low values when the text is fragmentary, garbled, or ambiguous.",
    `- negative_contexts: which of these contexts are present in the scene (shown, happening, or discussed as current events): ${JSON.stringify(negativeVocab)}. Use only these exact strings. Include a context with a lower confidence if it is plausible; omit it if clearly absent. Be cautious: when in doubt, include it.`,
    "- The transcript is machine-generated and may contain errors. Judge meaning, not exact wording.",
  ].join("\n");
}

export function scenesUserPrompt(segments: Segment[]): string {
  return segments.map((s) => `[${s.id}] ${fmt(s.start)}–${fmt(s.end)} ${s.text}`).join("\n");
}

export function scenesJsonSchema(negativeVocab: string[]) {
  const vocab = negativeVocab.length ? negativeVocab : ["__none__"];
  return {
    type: "object",
    additionalProperties: false,
    required: ["scenes"],
    properties: {
      scenes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "first_segment_id",
            "last_segment_id",
            "summary",
            "activity",
            "mood",
            "closure",
            "tension",
            "confidence",
            "negative_contexts",
          ],
          properties: {
            first_segment_id: { type: "integer" },
            last_segment_id: { type: "integer" },
            summary: { type: "string" },
            activity: { type: "string" },
            mood: { type: "string" },
            closure: { type: "number" },
            tension: { type: "number" },
            confidence: { type: "number" },
            negative_contexts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["context", "confidence"],
                properties: {
                  context: { type: "string", enum: vocab },
                  confidence: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  };
}

const unit = z.number().transform((n) => Math.min(1, Math.max(0, n)));

export const ScenesResponse = z.object({
  scenes: z.array(
    z.object({
      first_segment_id: z.number().int(),
      last_segment_id: z.number().int(),
      summary: z.string(),
      activity: z.string(),
      mood: z.string(),
      closure: unit,
      tension: unit,
      confidence: unit,
      negative_contexts: z.array(z.object({ context: z.string(), confidence: unit })),
    }),
  ),
});

export type LlmScene = z.infer<typeof ScenesResponse>["scenes"][number];
