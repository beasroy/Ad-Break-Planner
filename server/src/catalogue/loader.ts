// The ONLY module that knows the catalogue file format. When the format
// changes, change the schema + mapping here and nothing else.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../lib/artifacts";
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
  headline: z.string().optional(),
  tagline: z.string().optional(),
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
      ...(b.headline && { headline: b.headline }),
      ...(b.tagline && { tagline: b.tagline }),
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

// ---- Editing (brands page). Writes are serialised and the result is validated before it is saved.

export type RawBrandInput = z.input<typeof RawBrand>;

let writing: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = writing.then(fn);
  writing = next.catch(() => undefined);
  return next;
}

async function readRaw(cataloguePath: string): Promise<{ list: RawBrandInput[]; wrapped: boolean }> {
  const raw = JSON.parse(await fs.readFile(cataloguePath, "utf8"));
  return Array.isArray(raw) ? { list: raw, wrapped: false } : { list: raw.brands, wrapped: true };
}

async function writeRaw(cataloguePath: string, list: RawBrandInput[], wrapped: boolean) {
  const out = wrapped ? { brands: list } : list;
  parseCatalogue(out, path.dirname(cataloguePath)); // never save a catalogue the loader would reject
  await writeFileAtomic(cataloguePath, JSON.stringify(out, null, 2) + "\n");
}

/** Pure: a new brand id from its display name, unique among `taken` (brand_<slug>, brand_<slug>_2, ...). */
export function brandIdFor(name: string, taken: Set<string>): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "custom";
  let id = `brand_${slug}`;
  for (let n = 2; taken.has(id); n++) id = `brand_${slug}_${n}`;
  return id;
}

export const catalogueBrandIds = async (cataloguePath: string) =>
  new Set((await readRaw(cataloguePath)).list.map((b) => b.brand_id));

export function addBrand(cataloguePath: string, brand: RawBrandInput): Promise<void> {
  return serialised(async () => {
    const { list, wrapped } = await readRaw(cataloguePath);
    if (list.some((b) => b.brand_id === brand.brand_id)) throw new Error(`brand ${brand.brand_id} already exists`);
    await writeRaw(cataloguePath, [...list, brand], wrapped);
  });
}

export function removeBrand(cataloguePath: string, brandId: string): Promise<boolean> {
  return serialised(async () => {
    const { list, wrapped } = await readRaw(cataloguePath);
    const rest = list.filter((b) => b.brand_id !== brandId);
    if (rest.length === list.length) return false;
    if (!rest.length) throw new Error("the catalogue needs at least one brand");
    await writeRaw(cataloguePath, rest, wrapped);
    return true;
  });
}
