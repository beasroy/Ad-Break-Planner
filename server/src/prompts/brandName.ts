import { z } from "zod";

export const BRAND_NAME_PROMPT_VERSION = 1;

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
