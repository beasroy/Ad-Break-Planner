import { z } from "zod";
import type { Brand, Scene } from "shared";

export const RANK_PROMPT_VERSION = 1;

export const rankSystemPrompt = [
  "You match an ad break in a Bengali TV drama to the most contextually relevant brands.",
  "The ad plays right after the 'scene before'. A brand fits when its target contexts relate to what viewers just watched (activity, setting, objects, mood).",
  "Score every listed brand. fit (0–1): 0 = unrelated, 0.5 = loosely related, 1 = directly matches the scene's activity.",
  "reason: one short English sentence referring to the scene. Use only the brand ids provided.",
].join("\n");

export function rankUserPrompt(before: Scene, after: Scene, brands: Brand[]): string {
  return JSON.stringify(
    {
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
