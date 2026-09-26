import { z } from "zod";

export const BRAND_COPY_PROMPT_VERSION = 1;

// ---- Guard: brands must be synthetic. A real company name is an auto-disqualifier.

export const realNameSystemPrompt = [
  "You check whether a proposed advertiser name is a real company, brand or trademark (anywhere in the world, including Indian and Bengali brands).",
  "Answer true if the name is, contains, or is a near-spelling of a real brand (e.g. 'Nestle Foods', 'Airtel Plus', 'Amazonn').",
  "Generic or clearly made-up names (e.g. 'Brand X', 'Synth Ninth Paints', 'Golden Spoon Spices') are not real.",
].join(" ");

export const realNameUserPrompt = (name: string, category: string) => JSON.stringify({ name, category });

export const realNameJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["is_real_brand", "matches"],
  properties: { is_real_brand: { type: "boolean" }, matches: { type: "string" } },
};

export const RealNameResponse = z.object({ is_real_brand: z.boolean(), matches: z.string() });

// ---- Ad copy shown over the creative.

export const copySystemPrompt = [
  "You write short TV ad copy for a synthetic (fictional) brand on a Bengali streaming service.",
  "Use only the brand name given. Never mention, imply or imitate a real company, product or slogan.",
  "headline: at most 6 words. tagline: at most 12 words. Warm, family friendly, no claims about health or prices.",
].join(" ");

export const copyUserPrompt = (b: { name: string; category: string; targetContexts: string[]; language: string }) =>
  JSON.stringify({
    brand_name: b.name,
    category: b.category,
    shown_next_to_scenes_about: b.targetContexts.slice(0, 8),
    write_in: b.language === "bn" ? "Bengali (Bangla script)" : "English",
  });

export const copyJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "tagline"],
  properties: { headline: { type: "string" }, tagline: { type: "string" } },
};

export const CopyResponse = z.object({ headline: z.string().min(1), tagline: z.string().min(1) });

// ---- Image: the brand's world, no text (the player draws the copy; image models garble Bangla).

export const imagePrompt = (b: { category: string; targetContexts: string[] }) =>
  [
    `A warm, high-quality advertising photograph for a ${b.category || "consumer"} brand, set in West Bengal, India.`,
    `Show: ${b.targetContexts.slice(0, 5).join(", ")}.`,
    "Wide 16:9 composition with calm empty space on the left third for a headline.",
    "Do not include any text, letters, numbers, logos, brand names, packaging labels or watermarks.",
  ].join(" ");
