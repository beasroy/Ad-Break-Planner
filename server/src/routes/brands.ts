// Brands page: list, add (uploaded and/or generated creatives), delete, import/export catalogue
// JSON. The catalogue lives in the database; every change re-queues processed videos so no saved
// ad break was chosen with an outdated catalogue (negative contexts included).
import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import multer from "multer";
import type { BrandChangeResponse, BrandSummary, ImportCatalogueResponse, ListBrandsResponse } from "shared";
import { config } from "../config";
import { brandIdFor } from "../catalogue/loader";
import {
  addBrand,
  applyImport,
  brandIds,
  catalogueDir,
  exportCatalogue,
  loadCatalogue,
  planImport,
  removeBrand,
} from "../catalogue/store";
import { assertSyntheticName, brandAdsDir, ensureCreativeFiles, normaliseUpload, titleCardCreatives } from "../catalogue/creatives";
import { PermanentError } from "../lib/errors";
import { uploadStorage } from "../lib/uploads";
import { creativeUrl } from "../xml/vast";
import { rerunAllJobs } from "./jobs";

export const brandsRouter = Router();

const upload = multer({ storage: uploadStorage, limits: { fileSize: 500 * 1024 ** 2, files: 3 } });
const DEFAULT_DURATIONS = [15, 30];

const list = (v: unknown) =>
  String(v ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const requester = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

async function summaries(): Promise<ListBrandsResponse> {
  const cat = await loadCatalogue();
  const brands: BrandSummary[] = cat.brands.map((b) => ({
    id: b.id,
    name: b.name,
    category: b.category,
    targetContexts: b.targetContexts,
    negativeContexts: b.negativeContexts,
    headline: b.headline,
    tagline: b.tagline,
    creatives: b.creatives.map((c) => ({
      id: c.id,
      durationSec: c.durationSec,
      language: c.language,
      url: creativeUrl(config.publicBaseUrl, b.id, c.id),
    })),
  }));
  return { brands, catalogueHash: cat.hash };
}

// PROVISIONAL
brandsRouter.get("/api/brands", async (_req, res, next) => {
  try {
    res.json(await summaries());
  } catch (err) {
    next(err);
  }
});

// PROVISIONAL: multipart. Fields: name, category, targetContexts, negativeContexts (comma or
// newline separated), language (bn|en), generate ("true": title-card ads), durations ("15,30");
// files: creatives (uploaded ad videos).
brandsRouter.post("/api/brands", upload.array("creatives", 3), async (req, res, next) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  let dir: string | undefined;
  try {
    const name = String(req.body.name ?? "").trim();
    const category = String(req.body.category ?? "").trim();
    const targetContexts = list(req.body.targetContexts);
    const negativeContexts = list(req.body.negativeContexts);
    const language = req.body.language === "en" ? "en" : "bn";
    const generate = req.body.generate === "true";
    const durations = list(req.body.durations).map(Number).filter((d) => [10, 15, 20, 30].includes(d));

    if (name.length < 2 || name.length > 60) throw new PermanentError("Name must be 2–60 characters");
    if (!targetContexts.length) throw new PermanentError("Add at least one target context (what scenes the brand fits)");
    if (!files.length && !generate) throw new PermanentError("Upload at least one ad video or choose to generate one");

    await assertSyntheticName(name, category);
    const id = brandIdFor(name, brandIds());
    dir = brandAdsDir(id);
    await fs.mkdir(dir, { recursive: true });

    const short = id.replace(/^brand_/, "").slice(0, 24);
    const creatives: { id: string; durationSec: number; language: string; file: string }[] = [];
    for (const [i, f] of files.entries()) {
      const tmp = path.join(dir, `upload_${i + 1}.mp4`);
      const durationSec = await normaliseUpload(f.path, tmp);
      const cid = `${short}_${Math.round(durationSec)}s_${language}_up${i + 1}`;
      const file = path.join(dir, `${cid}.mp4`);
      await fs.rename(tmp, file);
      creatives.push({ id: cid, durationSec, language, file });
    }

    if (generate) {
      creatives.push(
        ...(await titleCardCreatives({ id, name, category, targetContexts }, dir, durations.length ? durations : DEFAULT_DURATIONS, language)),
      );
    }

    addBrand(
      {
        brand_id: id,
        display_name: name,
        category,
        target_contexts: targetContexts,
        negative_contexts: negativeContexts,
        creatives: creatives.map((c) => ({
          id: c.id,
          duration_sec: c.durationSec,
          language: c.language,
          url: path.relative(catalogueDir(), c.file).split(path.sep).join("/"),
        })),
      },
      requester(req),
    );
    dir = undefined; // saved: keep the files
    const requeuedJobs = rerunAllJobs(`brand added: ${name}`, requester(req));
    const brand = (await summaries()).brands.find((b) => b.id === id);
    res.status(201).json({ brand, requeuedJobs } satisfies BrandChangeResponse);
  } catch (err) {
    if (err instanceof PermanentError) res.status(422).json({ error: err.message });
    else next(err);
  } finally {
    await Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

// PROVISIONAL: removes the brand from the catalogue and its creatives folder.
brandsRouter.delete("/api/brands/:id", async (req, res, next) => {
  try {
    const removed = removeBrand(req.params.id, requester(req));
    if (!removed) return res.status(404).json({ error: "brand not found" });
    await fs.rm(brandAdsDir(req.params.id), { recursive: true, force: true });
    const requeuedJobs = rerunAllJobs(`brand removed: ${req.params.id}`, requester(req));
    res.json({ requeuedJobs } satisfies BrandChangeResponse);
  } catch (err) {
    if (err instanceof Error && /at least one brand/.test(err.message)) res.status(409).json({ error: err.message });
    else next(err);
  }
});

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 ** 2, files: 1 } });

// PROVISIONAL: multipart. file: catalogue (brands.json format); mode: merge | replace.
// Creatives whose files do not exist get a title-card ad (brand name, category, contexts).
brandsRouter.post("/api/brands/import", importUpload.single("catalogue"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "multipart field 'catalogue' (a JSON file) is required" });
    const mode = req.body.mode === "replace" ? "replace" : "merge";
    let raw: unknown;
    try {
      raw = JSON.parse(req.file.buffer.toString("utf8"));
    } catch (err) {
      throw new PermanentError(`Not valid JSON: ${(err as Error).message.slice(0, 120)}`);
    }
    let plan;
    try {
      plan = planImport(raw, mode);
    } catch (err) {
      throw new PermanentError(`Not a valid catalogue: ${formatZod(err)}`);
    }
    // Synthetic names only (auto-disqualifier): every new or renamed brand is checked.
    const current = new Map(exportCatalogue().map((b) => [b.brand_id, b.display_name]));
    for (const b of plan.next) {
      if (current.get(b.brand_id) !== b.display_name) await assertSyntheticName(b.display_name, b.category ?? "");
    }
    const madeCreatives = await ensureCreativeFiles(plan.next, catalogueDir());
    try {
      applyImport(plan, mode, requester(req), req.file.originalname);
    } catch (err) {
      throw new PermanentError(`Not a valid catalogue: ${formatZod(err)}`);
    }
    const requeuedJobs = rerunAllJobs(`catalogue imported (${mode})`, requester(req));
    res.json({
      added: plan.added,
      updated: plan.updated,
      removed: plan.removed,
      generatedCreatives: madeCreatives,
      requeuedJobs,
    } satisfies ImportCatalogueResponse);
  } catch (err) {
    if (err instanceof PermanentError) res.status(422).json({ error: err.message });
    else next(err);
  }
});

/** First few validation problems of a zod error as one readable line; other errors as-is. */
function formatZod(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues?.length) return (err as Error).message.slice(0, 200);
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
