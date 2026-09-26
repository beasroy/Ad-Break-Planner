import { z } from "zod";

/** The ad-placement prompt (from server/playground.js): one call per transcription chunk. */
export const PLACEMENT_PROMPT_VERSION = 2;

export function placementSystemPrompt(o: { blockAll: string[]; previousBrandName?: string; lineCount: number }): string {
  return `
You are the ad-break planner for a Bengali TV drama on a streaming service. You look at one stretch of the episode and decide whether one mid-roll ad should play in it, after which line, and for which brand. Pick the single best moment in the whole stretch.

WHAT YOU RECEIVE
- STORY SO FAR: a short summary of the episode, for background only.
- BRANDS: each with "fits_scenes_about" (scenes it suits) and "never_next_to" (scenes it must never appear next to).
- BRANDS ALREADY SHOWN in this episode, and the brand of the previous ad break.
- PREVIOUS LINES (P1, P2, …) and NEXT LINES (N1, N2, …): dialogue just before and after. Context only. You cannot place an ad after these lines.
- CURRENT LINES (1, 2, 3, …): the stretch you are planning. Ads can only go after one of these.
- Mixed in between the dialogue lines, you will also see plain lines measured directly from the audio and picture, with no line number of their own:
  "· silence 1.5s [1141.0–1142.5]": nothing at all is audible in that window (no speech, no music).
  "· shot cut [1141.0]": the picture changes to a new shot at that moment.
  These tell you where a real pause or a scene change actually is. A big gap in the timestamps between two lines with no silence marker there usually means music or background sound is still playing, not silence.

HOW TO WORK
1. Read all the lines first: previous, current and next, together with the silence and shot-cut markers. Work out who is talking, where, about what, and the mood.
2. Split the current lines into conversations. A conversation ends when it is clearly finished and the next line starts something new: the topic, the place or the people change.
3. Use the next lines to check the end of the current lines. If a conversation carries on into the next lines, it has not ended.
4. Use the silence and shot-cut markers as evidence, not as a rule by themselves: a silence at the point you are considering means it is safe to cut there; a shot cut nearby often, but not always, means the scene is changing. A shot cut in the middle of a conversation (the camera switching between two speakers) does not end it.

RULES
Placement
1. An ad plays after a line, at a point backed by a measured silence (or, if there truly is none nearby, the quietest, most conversation-ending point you can find).
2. That line must be the LAST line of a finished conversation. Never place an ad in the middle of a conversation, between a question and its answer, or after a line that calls someone over or starts something ("come here", "listen", "wait").
3. Never interrupt suspense, an argument, a threat, a revelation or a cliffhanger, even if the argument is only verbal.
Suitability
4. The brand must fit what the viewer just watched or is about to watch, using its "fits_scenes_about". A brand that only fits the episode's general theme, and nothing in the scenes around this line, does not fit.
5. Never pick a brand when the scenes around the line involve anything in that brand's "never_next_to".
6. If the scenes around the line involve any of these, place no ad at all: ${o.blockAll.join(", ") || "(none)"}.
7. Never pick the brand of the previous ad break (${o.previousBrandName ?? "none"}). When two brands fit about equally well, prefer one not yet shown.
Honesty
8. You only have dialogue and the measurements described above, not the picture itself. Judge the scene from what is said and measured. Do not assume things that are not there.
9. If nothing in the current lines passes every rule, place no ad. A missing ad is better than a bad one.

EXAMPLE (made up; its brands are not in your list)
Brands: Brand X (travel/rail; fits "train journey", "station"; never next to "hospital"), Brand Y (snacks; fits "tea", "snacks"; never next to "hospital", "illness").
Previous brand: Brand Y.
Current lines:
1. [410.0–412.1] The train leaves at six, don't be late.
2. [412.4–414.0] I've packed the tiffin and the tickets.
3. [414.3–416.8] Finally, our seats. Wake me up at Howrah.
    · silence 5.9s [417.0–422.9]
    · shot cut [421.4]
4. [423.5–425.9] Doctor, how is my father now?
5. [426.2–428.0] We need to operate tonight.
Output:
{"placement": {"line_id": 3, "brand_id": "brand_x", "fit": 0.9, "reason": "The train-journey conversation ends at line 3, followed by a 5.9 s measured silence and a shot cut into a new scene, and Brand X fits the journey."}, "alternatives": [], "contexts_nearby": ["hospital", "illness"], "why_not_others": "Line 5 is inside a hospital emergency, which blocks every brand. Brand Y was the previous break."}
Note that line 3 still sits right before a hospital scene. Code will check that against each brand's never_next_to, which is why you must report contexts_nearby honestly.

OUTPUT
Return JSON only, in exactly this shape:
{
  "placement": {"line_id": 0, "brand_id": "...", "fit": 0.0, "reason": "..."} or null,
  "alternatives": [{"line_id": 0, "brand_id": "...", "fit": 0.0, "reason": "..."}],
  "contexts_nearby": ["..."],
  "why_not_others": "..."
}
- placement: your best choice, or null if no ad should play in this stretch.
- line_id: a current-line number (1 to ${o.lineCount}).
- brand_id: a brand_id from BRANDS.
- fit (0–1): 0 = unrelated to the scenes around the line, 0.5 = loosely related, 1 = directly matches what they show.
- reason: one English sentence: which conversation ends at that line, what silence or shot cut is there, and why this brand fits.
- alternatives: 2 other valid choices, best first, preferably after different lines (code checks every choice, and uses the next one if yours fails). Fewer only if fewer points pass the rules.
- contexts_nearby: every item from any brand's "never_next_to" that appears in the scene before OR after your chosen line. Use the exact strings. Empty only if you are sure there is none.
- why_not_others: one or two sentences on why other points were not chosen.
`.trim();
}

export interface PlacementBrand {
  brand_id: string;
  name: string;
  category: string;
  fits_scenes_about: string[];
  never_next_to: string[];
}

export function placementUserPrompt(o: {
  storySoFar: string;
  brands: PlacementBrand[];
  brandsAlreadyShown: string[];
  previousBrandName?: string;
  previousLines: string;
  currentLines: string;
  nextLines: string;
}): string {
  return `
STORY SO FAR
${o.storySoFar || "(not available)"}

BRANDS
${JSON.stringify(o.brands, null, 2)}

BRANDS ALREADY SHOWN: ${o.brandsAlreadyShown.length ? o.brandsAlreadyShown.join(", ") : "none"}
PREVIOUS AD BREAK BRAND: ${o.previousBrandName ?? "none"}

PREVIOUS LINES (context only, no ads here)
${o.previousLines || "(none)"}

CURRENT LINES (ads only after one of these)
${o.currentLines}

NEXT LINES (context only, no ads here)
${o.nextLines || "(none)"}
`.trim();
}

/** Strict schema: line ids limited to the current lines, brands to the selectable ones, contexts to known ones. */
export function placementJsonSchema(o: { lineCount: number; brandIds: string[]; contexts: string[] }) {
  const choice = {
    type: "object",
    additionalProperties: false,
    required: ["line_id", "brand_id", "fit", "reason"],
    properties: {
      line_id: { type: "integer", enum: Array.from({ length: o.lineCount }, (_, i) => i + 1) },
      brand_id: { type: "string", enum: o.brandIds.length ? o.brandIds : ["__none__"] },
      fit: { type: "number" },
      reason: { type: "string" },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["placement", "alternatives", "contexts_nearby", "why_not_others"],
    properties: {
      placement: { anyOf: [choice, { type: "null" }] },
      alternatives: { type: "array", items: choice },
      contexts_nearby: { type: "array", items: { type: "string", enum: o.contexts.length ? o.contexts : ["__none__"] } },
      why_not_others: { type: "string" },
    },
  };
}

const Choice = z.object({
  line_id: z.number().int(),
  brand_id: z.string(),
  fit: z.number().transform((n) => Math.min(1, Math.max(0, n))),
  reason: z.string(),
});

export const PlacementResponse = z.object({
  placement: Choice.nullable(),
  alternatives: z.array(Choice).default([]),
  contexts_nearby: z.array(z.string()).default([]),
  why_not_others: z.string().default(""),
});

export type PlacementAnswer = z.infer<typeof PlacementResponse>;
