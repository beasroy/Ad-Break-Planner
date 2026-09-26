// The brand catalogue lives in the database. catalogue/brands.json only seeds an empty database
// (fresh install, wiped data/) and is the import/export format. Every write is validated with
// the same parser as the JSON file, then saved in one transaction and audited.
import fs from "node:fs";
import path from "node:path";
import type { Catalogue, Job } from "shared";
import { config } from "../config";
import { getRepo, initDb, maybeRepo, type Requester } from "../db";
import type { BrandSource } from "../db/repo";
import { loadCatalogueFile, parseCatalogue, parseRawCatalogue, type RawBrandData } from "./loader";

/** Creative `url`s in the catalogue are relative to this folder (catalogue/ by default). */
export const catalogueDir = () => path.dirname(config.cataloguePath);

/** For scripts: opens the database (seeding the catalogue if empty) and returns the live catalogue. */
export async function openCatalogue(): Promise<Catalogue> {
  if (!maybeRepo()) initDb(config.dbPath);
  await seedCatalogueIfEmpty();
  return loadCatalogue();
}

/** The live catalogue, in the shape every pipeline stage uses. */
export async function loadCatalogue(): Promise<Catalogue> {
  return parseCatalogue(getRepo().listBrandsRaw(), catalogueDir());
}

export const exportCatalogue = (): RawBrandData[] => getRepo().listBrandsRaw();
export const brandIds = () => new Set(getRepo().listBrandsRaw().map((b) => b.brand_id));

/** Validates and saves the full catalogue. Throws (saving nothing) if the result is invalid. */
function commit(next: RawBrandData[], source: BrandSource) {
  if (!next.length) throw new Error("the catalogue needs at least one brand");
  for (const b of next) for (const c of b.creatives) assertSafeUrl(c.url);
  parseCatalogue(next, catalogueDir());
  getRepo().replaceCatalogue(next, source);
}

/** A creative path must stay inside the catalogue folder (imports are untrusted input). */
export function assertSafeUrl(url: string) {
  const dir = catalogueDir();
  const file = path.resolve(dir, url);
  if (path.isAbsolute(url) || !file.startsWith(dir + path.sep) || !/\.(mp4|mov|webm|m4v)$/i.test(url)) {
    throw new Error(`creative url "${url}" must be a relative path to a video inside the catalogue folder`);
  }
}

/** Fills an empty database from catalogue/brands.json. Returns how many brands were seeded. */
export async function seedCatalogueIfEmpty(file = config.cataloguePath): Promise<number> {
  const repo = getRepo();
  if (repo.listBrandsRaw().length || !fs.existsSync(file)) return 0;
  await loadCatalogueFile(file); // same validation as always
  const list = parseRawCatalogue(JSON.parse(fs.readFileSync(file, "utf8")));
  commit(list, "seed");
  repo.catalogueEvent({ actor: "system", type: "catalogue.seeded", detail: { file: path.basename(file), brands: list.length } });
  return list.length;
}

export function addBrand(brand: RawBrandData, requester?: Requester) {
  const list = getRepo().listBrandsRaw();
  if (list.some((b) => b.brand_id === brand.brand_id)) throw new Error(`brand ${brand.brand_id} already exists`);
  commit([...list, brand], "ui");
  getRepo().catalogueEvent({ actor: "api", type: "brand.created", brandId: brand.brand_id, requester, detail: { name: brand.display_name } });
}

export function removeBrand(brandId: string, requester?: Requester): boolean {
  const list = getRepo().listBrandsRaw();
  const gone = list.find((b) => b.brand_id === brandId);
  if (!gone) return false;
  commit(
    list.filter((b) => b.brand_id !== brandId),
    "ui",
  );
  getRepo().catalogueEvent({ actor: "api", type: "brand.deleted", brandId, requester, detail: { name: gone.display_name } });
  return true;
}

export function setBrandCopy(brandId: string, copy: { headline: string; tagline: string }) {
  const list = getRepo().listBrandsRaw();
  const b = list.find((x) => x.brand_id === brandId);
  if (!b) throw new Error(`brand ${brandId} not found`);
  Object.assign(b, copy);
  commit(list, "ui");
  getRepo().catalogueEvent({ actor: "system", type: "brand.copy_updated", brandId, detail: copy });
}

export interface ImportPlan {
  next: RawBrandData[];
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Pure-ish (reads the current catalogue): what an import would change. "merge" adds new brands
 * and replaces ones with the same brand_id; "replace" makes the file the whole catalogue.
 */
export function planImport(raw: unknown, mode: "merge" | "replace"): ImportPlan {
  const incoming = parseRawCatalogue(raw);
  const ids = new Set<string>();
  for (const b of incoming) {
    if (ids.has(b.brand_id)) throw new Error(`Duplicate brand id in catalogue: ${b.brand_id}`);
    ids.add(b.brand_id);
    for (const c of b.creatives) assertSafeUrl(c.url);
  }
  const current = getRepo().listBrandsRaw();
  const currentIds = new Set(current.map((b) => b.brand_id));
  const added = incoming.filter((b) => !currentIds.has(b.brand_id)).map((b) => b.brand_id);
  const updated = incoming.filter((b) => currentIds.has(b.brand_id)).map((b) => b.brand_id);
  if (mode === "replace") {
    return { next: incoming, added, updated, removed: current.filter((b) => !ids.has(b.brand_id)).map((b) => b.brand_id) };
  }
  const byId = new Map(incoming.map((b) => [b.brand_id, b]));
  const next = [...current.map((b) => byId.get(b.brand_id) ?? b), ...incoming.filter((b) => !currentIds.has(b.brand_id))];
  return { next, added, updated, removed: [] };
}

export function applyImport(plan: ImportPlan, mode: "merge" | "replace", requester?: Requester, fileName?: string) {
  commit(plan.next, "import");
  getRepo().catalogueEvent({
    actor: "api",
    type: "catalogue.imported",
    requester,
    detail: { mode, file: fileName, added: plan.added, updated: plan.updated, removed: plan.removed },
  });
}

/** The live catalogue's hash; undefined if it cannot be read (never breaks job listings). */
export function currentCatalogueHash(): string | undefined {
  try {
    return parseCatalogue(getRepo().listBrandsRaw(), catalogueDir()).hash;
  } catch {
    return undefined;
  }
}

/** Marks a finished job whose breaks were chosen with a different catalogue than the current one. */
export function withStaleFlag(job: Job): Job {
  const now = currentCatalogueHash();
  return { ...job, catalogueStale: job.status === "done" && !!now && !!job.catalogueHash && job.catalogueHash !== now };
}
