import { z } from "zod";
import type { Brand, ProgrammeContext, Scene } from "shared";

/** v3: fit comes only from the two scenes next to the break; the programme is background, never a reason. */
export const RANK_PROMPT_VERSION = 3;

export const rankSystemPrompt = [
  "You match an ad break in a Bengali TV programme to the most contextually relevant brands.",
  "The ad plays between 'scene_before' and 'scene_after'. Judge fit ONLY from these two scenes: their activity, setting, objects and mood.",
  "'programme' describes the whole episode. Use it only to understand what the two scenes show. A brand that matches the programme's theme or recurring contexts but nothing in these two scenes is NOT relevant: give it fit 0.2 or lower.",
  "Score every listed brand. fit (0–1): 0 = unrelated to both scenes, 0.5 = loosely related to something in them, 1 = directly matches what a scene shows.",
  "reason: one short English sentence naming what in scene_before or scene_after the brand relates to. Use only the brand ids provided.",
].join("\n");

export function rankUserPrompt(before: Scene, after: Scene, brands: Brand[], programme?: ProgrammeContext): string {
  return JSON.stringify(
    {
      ...(programme && {
        programme: { summary: programme.summary, genre: programme.genre, recurring_contexts: programme.recurringContexts },
      }),
      scene_before: { summary: before.summary, activity: before.activity, mood: before.mood },
      scene_after: { summary: after.summary, activity: after.activity, mood: after.mood },
      brands: brands.map((b) => ({ id: b.id, category: b.category, target_contexts: b.targetContexts })),
    },
    null,
    2,
  );
}

export function rankJsonSchema(brandIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rankings"],
    properties: {
      rankings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["brand_id", "fit", "reason"],
          properties: {
            brand_id: { type: "string", enum: brandIds },
            fit: { type: "number" },
            reason: { type: "string" },
          },
        },
      },
    },
  };
}

export const RankResponse = z.object({
  rankings: z.array(
    z.object({
      brand_id: z.string(),
      fit: z.number().transform((n) => Math.min(1, Math.max(0, n))),
      reason: z.string(),
    }),
  ),
});
