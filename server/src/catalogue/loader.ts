// The ONLY module that knows the catalogue file format. When the format
// changes, change the schema + mapping here and nothing else.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Brand, Catalogue } from "shared";

const RawCreative = z.object({
  id: z.string().min(1),
  duration_sec: z.number().positive(),
  language: z.string().default(""),
  url: z.string().min(1),
});

const RawBrand = z.object({
  brand_id: z.string().min(1),
  display_name: z.string().min(1),
  category: z.string().default(""),
  target_contexts: z.array(z.string()).default([]),
  negative_contexts: z.array(z.string()).default([]),
  creatives: z.array(RawCreative).min(1),
});

const RawCatalogue = z.union([z.array(RawBrand), z.object({ brands: z.array(RawBrand) })]);

const normaliseContext = (s: string) => s.trim().toLowerCase();
const uniq = (xs: string[]) => [...new Set(xs.map(normaliseContext).filter(Boolean))];

export function parseCatalogue(raw: unknown, catalogueDir: string): Catalogue {
  const parsed = RawCatalogue.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.brands;

  const seen = new Set<string>();
  const brands: Brand[] = list.map((b) => {
    if (seen.has(b.brand_id)) throw new Error(`Duplicate brand id in catalogue: ${b.brand_id}`);
    seen.add(b.brand_id);
    return {
      id: b.brand_id,
      name: b.display_name,
      category: b.category,
      targetContexts: uniq(b.target_contexts),
      negativeContexts: uniq(b.negative_contexts),
      creatives: b.creatives.map((c) => ({
        id: c.id,
        durationSec: c.duration_sec,
        language: c.language,
        file: path.resolve(catalogueDir, c.url),
      })),
    };
  });

  const negativeVocab = [...new Set(brands.flatMap((b) => b.negativeContexts))].sort();
  const hash = crypto.createHash("sha256").update(JSON.stringify(brands)).digest("hex").slice(0, 16);
  return { brands, negativeVocab, hash };
}

export async function loadCatalogue(cataloguePath: string): Promise<Catalogue> {
  const raw = JSON.parse(await fs.readFile(cataloguePath, "utf8"));
  return parseCatalogue(raw, path.dirname(cataloguePath));
}
